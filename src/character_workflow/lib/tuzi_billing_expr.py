"""Restricted Tuzi expressions, verified against its public pricing calculator.

Source: api.tu-zi.com/assets/index-DMNydVyD.js (2026-10-25), tF/nF/sF.
Unknown provider extensions fail closed; no expression is dynamically executed.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class UnsupportedBillingExpr(ValueError):
    pass


_TOKEN = re.compile(r'\s*("(?:[^"\\]|\\.)*"|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|'
                    r'[A-Za-z_][A-Za-z_0-9]*|\|\||&&|==|!=|<=|>=|[?:()+*/<>,\-])')
_FUNCTIONS = {"param": 1, "upper": 1, "lower": 1, "has": 2, "max": 2,
              "tier": 2, "hour": 1, "minute": 1, "weekday": 1,
              "imagePixels": 1, "imageSizeTier": 1}
_VARIABLES = {"output_image_count", "input_image_count", "output_image_type", "nil", "true"}
_LEVELS = [("||",), ("&&",), ("==", "!="), ("<", "<=", ">", ">="),
           ("+", "-"), ("*", "/")]


class _Parser:
    def __init__(self, expression: str):
        if not isinstance(expression, str) or len(expression) > 32768:
            raise UnsupportedBillingExpr("invalid expression length")
        body = expression.removeprefix("v2:").strip()
        self.tokens = []
        pos = 0
        while pos < len(body):
            match = _TOKEN.match(body, pos)
            if not match:
                raise UnsupportedBillingExpr(f"invalid token at {pos}")
            self.tokens.append(match[1])
            pos = match.end()
        self.tokens.append("")
        self.index = 0

    def take(self, expected=None):
        token = self.tokens[self.index]
        if expected is not None and token != expected:
            raise UnsupportedBillingExpr(f"expected {expected}")
        self.index += 1
        return token

    def parse(self, level=0):
        if level == len(_LEVELS):
            token = self.take()
            if token == "(":
                node = self.conditional()
                self.take(")")
                return node
            if token in ("+", "-"):
                return ("unary", token, self.parse(level))
            if token.startswith('"'):
                return ("value", json.loads(token))
            if token and token[0].isdigit():
                return ("value", float(token))
            if self.tokens[self.index] == "(":
                if token not in _FUNCTIONS:
                    raise UnsupportedBillingExpr(f"unverified function: {token}")
                self.take("(")
                args = []
                if self.tokens[self.index] != ")":
                    args.append(self.conditional())
                    while self.tokens[self.index] == ",":
                        self.take(",")
                        args.append(self.conditional())
                self.take(")")
                if len(args) != _FUNCTIONS[token]:
                    raise UnsupportedBillingExpr(f"invalid arity: {token}")
                return ("call", token, args)
            if token not in _VARIABLES:
                raise UnsupportedBillingExpr(f"unverified variable: {token}")
            return ("variable", token)
        node = self.parse(level + 1)
        while self.tokens[self.index] in _LEVELS[level]:
            op = self.take()
            node = ("binary", op, node, self.parse(level + 1))
        return node

    def conditional(self):
        node = self.parse()
        if self.tokens[self.index] == "?":
            self.take("?")
            yes = self.conditional()
            self.take(":")
            node = ("conditional", node, yes, self.conditional())
        return node


def compile_expression(expression: str):
    try:
        parser = _Parser(expression)
        node = parser.conditional()
        if parser.tokens[parser.index] != "":
            raise UnsupportedBillingExpr("trailing tokens")
        return node
    except (ValueError, IndexError, RecursionError) as error:
        raise UnsupportedBillingExpr(str(error)) from error


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise UnsupportedBillingExpr("expected finite number")
    return value


def _boolean(value):
    if not isinstance(value, bool):
        raise UnsupportedBillingExpr("expected boolean")
    return value


def _string(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)) and math.isfinite(value):
        return str(int(value)) if value == int(value) else str(value)
    raise UnsupportedBillingExpr("unsupported string conversion")


def image_size_tier(value):
    """Official tF uses parseInt and longest edge, not total pixels."""
    size = _string(value).strip().upper()
    if size in {"1K", "2K", "4K"}:
        return size
    parts = re.split(r"[X*×]", size)
    if len(parts) != 2:
        return "default"
    matches = [re.match(r"^[+-]?[0-9]+", part.strip()) for part in parts]
    if not all(matches):
        return "default"
    edges = [int(match[0]) for match in matches]
    if min(edges) <= 0:
        return "default"
    longest = max(edges)
    return "4K" if longest >= 3840 else "2K" if longest >= 2048 else (
        "1K" if longest >= 1024 else "default"
    )


def image_pixels(value):
    """Official nF accepts positive integer dimensions after JS Number conversion."""
    size = _string(value).strip().upper()
    if size in {"1K", "2K", "4K"}:
        return {"1K": 1024**2, "2K": 2048**2, "4K": 4096**2}[size]
    parts = re.split(r"[X*×]", size)
    if len(parts) != 2:
        return 0
    if any(not re.fullmatch(
        r"(?:0B[01]+|0O[0-7]+|0X[0-9A-F]+|[+-]?(?:[0-9]+(?:\.[0-9]*)?|"
        r"\.[0-9]+)(?:E[+-]?[0-9]+)?)", part.strip(),
    ) for part in parts):
        return 0
    try:
        edges = [float(int(part.strip(), 0)) if re.fullmatch(
            r"0[Bb][01]+|0[Oo][0-7]+|0[Xx][0-9A-Fa-f]+", part.strip(),
        ) else float(part.strip()) for part in parts]
    except (ValueError, OverflowError):
        return 0
    if any(not math.isfinite(edge) or not edge.is_integer() or edge <= 0 for edge in edges):
        return 0
    return edges[0] * edges[1]


def evaluate(expression: str, *, params: dict, variables: dict,
             now: datetime | None = None) -> tuple[float, str | None]:
    """Return the formula amount and selected tier, without currency conversion."""
    tree = compile_expression(expression)
    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        raise UnsupportedBillingExpr("time must include timezone")
    tier = None

    def run(node):
        nonlocal tier
        kind = node[0]
        if kind == "value":
            return node[1]
        if kind == "variable":
            if node[1] == "nil":
                return None
            if node[1] == "true":
                return True
            if node[1] not in variables:
                raise UnsupportedBillingExpr(f"missing fact: {node[1]}")
            return variables[node[1]]
        if kind == "unary":
            value = _number(run(node[2]))
            return -value if node[1] == "-" else value
        if kind == "conditional":
            return run(node[2] if _boolean(run(node[1])) else node[3])
        if kind == "binary":
            op, left = node[1], run(node[2])
            if op == "&&":
                return _boolean(left) and _boolean(run(node[3]))
            if op == "||":
                return _boolean(left) or _boolean(run(node[3]))
            right = run(node[3])
            if op in ("==", "!="):
                equal = left == right and (isinstance(left, bool) == isinstance(right, bool))
                return equal if op == "==" else not equal
            a, b = _number(left), _number(right)
            if op == "+":
                return a + b
            if op == "-":
                return a - b
            if op == "*":
                return a * b
            if op == "/":
                return a / b
            return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]
        name, args = node[1], [run(arg) for arg in node[2]]
        if name == "max":
            return max(_number(args[0]), _number(args[1]))
        if name == "tier":
            if not isinstance(args[0], str):
                raise UnsupportedBillingExpr("tier name must be string")
            tier = args[0]
            return _number(args[1])
        if name == "has":
            needle = "null" if args[1] is None else _string(args[1])
            return args[0] is not None and needle in _string(args[0])
        if name in ("upper", "lower"):
            value = _string(args[0]).strip()
            return value.upper() if name == "upper" else value.lower()
        if name == "imagePixels":
            return image_pixels(args[0])
        if name == "imageSizeTier":
            return image_size_tier(args[0])
        if not isinstance(args[0], str):
            raise UnsupportedBillingExpr(f"unsupported {name} argument")
        value = args[0]
        if name == "param":
            if value.strip() not in {"model", "size", "quality", "n", "image.#",
                                    "generationConfig.imageConfig.imageSize",
                                    "layer_decomposition"}:
                raise UnsupportedBillingExpr(f"unverified request field: {value}")
            current = params
            for part in value.strip().split("."):
                if part == "#" and isinstance(current, list):
                    current = len(current)
                elif isinstance(current, dict):
                    current = current.get(part)
                else:
                    return None
            return current
        try:
            zone = ZoneInfo(value.strip() or "UTC")
        except ZoneInfoNotFoundError:
            raise UnsupportedBillingExpr("invalid timezone") from None
        local = instant.astimezone(zone)
        return {"hour": local.hour, "minute": local.minute,
                "weekday": (local.weekday() + 1) % 7}[name]

    try:
        amount = _number(run(tree))
        if amount < 0:
            raise UnsupportedBillingExpr("negative price")
        return float(amount), tier
    except (ValueError, TypeError, ArithmeticError, KeyError, RecursionError) as error:
        raise UnsupportedBillingExpr(str(error)) from error

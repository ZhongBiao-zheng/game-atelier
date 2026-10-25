"""Restricted Tuzi expressions. Unverified provider extensions fail closed.

Semantics: QuantumNous/new-api pkg/billingexpr/run.go. Tuzi's imagePixels and
imageSizeTier are not in that source; expressions using them remain unpriced.
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
              "tier": 2, "hour": 1, "minute": 1, "weekday": 1}
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
            if not isinstance(args[1], str) or (args[0] is not None
                                               and not isinstance(args[0], str)):
                raise UnsupportedBillingExpr("unsupported has argument")
            return bool(args[0] is not None and args[1] and args[1] in args[0])
        if not isinstance(args[0], str):
            raise UnsupportedBillingExpr(f"unsupported {name} argument")
        value = args[0]
        if name in ("upper", "lower"):
            return value.upper() if name == "upper" else value.lower()
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
            zone = timezone.utc
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

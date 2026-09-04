"""Dependency-only stdio fixture; not an Atelier tool server or Agent entry point."""
from mcp.server import MCPServer
from pydantic import BaseModel, ConfigDict, Field


server = MCPServer("atelier-sdk-dependency-probe")


class EchoInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(min_length=1, max_length=128)


class EchoResult(BaseModel):
    text: str


@server.tool()
def dependency_echo(payload: EchoInput) -> EchoResult:
    """Return test input without reading projects, files, keys or calling a provider."""
    return EchoResult(text=payload.text)


if __name__ == "__main__":
    server.run(transport="stdio")

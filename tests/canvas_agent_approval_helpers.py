"""Exercise the same approval hook the Agents SDK uses for a fresh turn."""
import asyncio
from types import SimpleNamespace

from character_workflow.lib import canvas_agent_runtime as runtime


def confirmation_required(project_id, tool, arguments, mode):
    hook = next(t.needs_approval for t in runtime.build_tools() if t.name == tool)
    if isinstance(hook, bool):
        return hook
    ctx = SimpleNamespace(context=runtime.TurnContext(project_id, mode), tool_call_id="call")
    return asyncio.run(hook(ctx, arguments, ctx.tool_call_id))

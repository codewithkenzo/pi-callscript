export const TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["bash", "run"],
  ["grep", "search"],
  ["ls", "list"],
]);

export const canonicalTool = (name: string) => TOOL_ALIASES.get(name) ?? name;

type ToolDefinition = { type: string; function: { name: string; description?: string; parameters?: any } }

export function formatMcpToolDefinition(tool: { name: string; description?: string; inputSchema?: any }, loaded: boolean): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      // Keep a selectable catalog, without repeating long usage manuals.
      description: loaded ? tool.description || '' : (tool.description || '').replace(/\s+/g, ' ').slice(0, 200),
      parameters: loaded ? tool.inputSchema || { type: 'object', properties: {} } : { type: 'object', properties: {} }
    }
  }
}

/** Upgrade selected definitions in place, using the existing local MCP cache.
 * Persist names only: a later turn resolves the current schema and permissions.
 */
export function loadMcpToolSchemas(
  definitions: ToolDefinition[],
  names: Iterable<string>,
  mcpToolNames: Set<string>,
  loadedNames: Set<string>,
  resolveDefinition: (name: string) => ToolDefinition | null
): boolean {
  let changed = false
  for (const name of names) {
    if (!mcpToolNames.has(name) || loadedNames.has(name)) continue
    const index = definitions.findIndex(tool => tool.function.name === name)
    // The definitions have already been filtered by the run's allow/block lists.
    if (index < 0) continue
    const definition = resolveDefinition(name)
    if (!definition || definition.function.name !== name) continue
    definitions[index] = definition
    loadedNames.add(name)
    changed = true
  }
  return changed
}

import { parseProject, requireProject } from "../utils/parse-project.js"
import { renderGraph } from "../utils/render-tree.js"

export function runTrace(flags: Record<string, string>, positional: string[]): void {
  const projectRoot = requireProject(flags)
  const routeFilter = positional[0]

  const { graphs, routeCount, fileCount } = parseProject(projectRoot)

  if (!routeFilter) {
    // List all routes
    console.log(`Routes (${routeCount} from ${fileCount} file(s)):\n`)
    for (const g of graphs) {
      console.log(`  ${g.method} ${g.path}`)
    }
    console.log(`\nTo inspect a route: archmind trace --project <path> "METHOD /path"`)
    return
  }

  // Find matching route — exact or substring match
  const needle = routeFilter.toLowerCase()
  const matches = graphs.filter((g) => {
    const key = `${g.method} ${g.path}`.toLowerCase()
    return key === needle || key.includes(needle) || g.path.toLowerCase().includes(needle)
  })

  if (matches.length === 0) {
    console.error(`No route matching "${routeFilter}"`)
    console.error(`Run without a route argument to list all routes.`)
    process.exit(1)
  }

  if (matches.length > 1) {
    console.log(`Multiple matches — showing all ${matches.length}:\n`)
  }

  for (const g of matches) {
    console.log(renderGraph(g))
    if (matches.length > 1) console.log()
  }
}

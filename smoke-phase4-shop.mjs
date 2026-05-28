import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from './packages/laravel-parser/dist/index.js'
import { join } from 'path'

const projectRoot = 'C:/Users/Admin/Desktop/DuckCode/New folder/laravel-shop'
const config = loadProjectConfig(projectRoot)
const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)

let shown = 0
for (const relFile of routeFiles) {
  const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
  for (const g of skeletons) {
    const aug = augmentGraph(g, { projectRoot, config })
    const svcNodes = aug.nodes.filter(n => n.type === 'service_call')
    const txnNodes = aug.nodes.filter(n => n.type === 'transaction_boundary')
    const wriNodes = aug.nodes.filter(n => n.type === 'transactional_write')
    const escNodes = aug.nodes.filter(n => n.type === 'transaction_escape')
    const qryNodes = aug.nodes.filter(n => n.type.includes('query'))

    if (svcNodes.length > 0 || txnNodes.length > 0) {
      console.log(`\n${aug.entrypoint}  (${aug.nodes.length} nodes)`)
      svcNodes.forEach(n => console.log(`  [service_call]         ${n.symbol}  file=${n.file ?? 'UNRESOLVED'}`))
      txnNodes.forEach(n => console.log(`  [transaction_boundary] ${n.symbol}`))
      wriNodes.forEach(n => console.log(`  [transactional_write]  ${n.symbol}`))
      escNodes.forEach(n => console.log(`  [transaction_escape]   ${n.symbol}`))
      qryNodes.forEach(n => console.log(`  [${n.type}] ${n.symbol}`))
      shown++
    }
  }
}
console.log(`\n--- ${shown} routes with service/txn nodes ---`)

import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from './packages/laravel-parser/dist/index.js'
import { join } from 'path'

const projectRoot = 'C:/Users/Admin/Desktop/DuckCode/New folder/easygo-shopping-laravel'
const config = loadProjectConfig(projectRoot)
const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)

for (const relFile of routeFiles) {
  const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
  for (const g of skeletons) {
    const aug = augmentGraph(g, { projectRoot, config })
    const svcNodes = aug.nodes.filter(n => n.type === 'service_call')
    const txnNodes = aug.nodes.filter(n => n.type === 'transaction_boundary')
    const qryNodes = aug.nodes.filter(n => n.type.includes('query'))
    const wriNodes = aug.nodes.filter(n => n.type === 'transactional_write')
    if (svcNodes.length + txnNodes.length + qryNodes.length > 0) {
      console.log(`\n${aug.entrypoint}  (${aug.nodes.length} nodes total)`)
      svcNodes.forEach(n => console.log(`  [service_call]        ${n.symbol}  file=${n.file ?? 'none'}`))
      txnNodes.forEach(n => console.log(`  [transaction_boundary] ${n.symbol}`))
      wriNodes.forEach(n => console.log(`  [transactional_write]  ${n.symbol}`))
      qryNodes.forEach(n => console.log(`  [${n.type}] ${n.symbol}`))
    }
  }
}

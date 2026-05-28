import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from './packages/laravel-parser/dist/index.js'
import { join } from 'path'

const BASE = 'C:/Users/Admin/Desktop/DuckCode/New folder'

const PROJECTS = [
  'easygo-shopping-laravel',
  'ecomerce-api',
  'laravel-b2b-ecommerce',
  'laravel-myweb1',
  'laravel-shop',
  'obsidian-admin-laravel',
  'redil-eccommerce',
]

for (const name of PROJECTS) {
  const projectRoot = `${BASE}/${name}`
  console.log(`\n${'='.repeat(60)}`)
  console.log(`PROJECT: ${name}`)
  console.log('='.repeat(60))

  let config, aliasMap, routeFiles
  try {
    config = loadProjectConfig(projectRoot)
    ;({ aliasMap, routeFiles } = resolveAliasMap(projectRoot, config))
  } catch (e) {
    console.log(`  ERROR loading config: ${e.message}`)
    continue
  }

  console.log(`  Route files: ${routeFiles.join(', ') || '(none)'}`)

  let totalRoutes = 0
  let routesWithNodes = 0

  for (const relFile of routeFiles) {
    let skeletons
    try {
      skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
    } catch (e) {
      console.log(`  ERROR parsing ${relFile}: ${e.message}`)
      continue
    }

    totalRoutes += skeletons.length

    for (const g of skeletons) {
      let aug
      try {
        aug = augmentGraph(g, { projectRoot, config })
      } catch (e) {
        console.log(`  ERROR augmenting ${g.entrypoint}: ${e.message}`)
        continue
      }

      const svcNodes = aug.nodes.filter(n => n.type === 'service_call')
      const txnNodes = aug.nodes.filter(n => n.type === 'transaction_boundary')
      const wriNodes = aug.nodes.filter(n => n.type === 'transactional_write')
      const escNodes = aug.nodes.filter(n => n.type === 'transaction_escape')
      const qryNodes = aug.nodes.filter(n => n.type.includes('query'))
      const authNodes = aug.nodes.filter(n => n.type === 'authorization_check' || n.type === 'authentication_gate' || n.type === 'policy')
      const frNodes  = aug.nodes.filter(n => n.type === 'form_request')

      const hasInteresting = svcNodes.length > 0 || txnNodes.length > 0 || authNodes.length > 0

      if (hasInteresting) {
        routesWithNodes++
        console.log(`\n  ${aug.entrypoint}  (${aug.nodes.length} nodes)`)
        authNodes.forEach(n => console.log(`    [${n.type.padEnd(20)}] ${n.symbol}`))
        frNodes.forEach(n  => console.log(`    [form_request         ] ${n.symbol}`))
        svcNodes.forEach(n => console.log(`    [service_call         ] ${n.symbol}  file=${n.file ?? 'UNRESOLVED'}`))
        txnNodes.forEach(n => console.log(`    [transaction_boundary ] ${n.symbol}`))
        wriNodes.forEach(n => console.log(`    [transactional_write  ] ${n.symbol}`))
        escNodes.forEach(n => console.log(`    [transaction_escape   ] ${n.symbol}`))
        qryNodes.forEach(n => console.log(`    [${n.type.padEnd(20)}] ${n.symbol}`))
      }
    }
  }

  console.log(`\n  SUMMARY: ${totalRoutes} routes parsed, ${routesWithNodes} with notable nodes`)
}

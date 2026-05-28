/**
 * Cross-project coverage report — auth/txn/iso/svc breakdown + dependency index per project.
 * Run after P0+P1+P3 to validate improvements across all fixture projects.
 */
import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from './packages/laravel-parser/dist/index.js'
import { buildDependencyIndex, indexStats } from './packages/retrieval/dist/index.js'
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

const totals = { routes: 0, authn: 0, authz: 0, txn: 0, iso: 0, noAuth: 0, listenerNodes: 0 }

for (const name of PROJECTS) {
  const projectRoot = `${BASE}/${name}`
  let config, aliasMap, routeFiles
  try {
    config = loadProjectConfig(projectRoot)
    ;({ aliasMap, routeFiles } = resolveAliasMap(projectRoot, config))
  } catch (e) {
    console.log(`${name}: ERROR loading config — ${e.message}`)
    continue
  }

  const projectGraphs = []
  let routes = 0, authn = 0, authz = 0, txn = 0, iso = 0, noAuth = 0, listeners = 0

  for (const relFile of routeFiles) {
    let skeletons
    try { skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap }) }
    catch { continue }

    for (const g of skeletons) {
      let aug
      try { aug = augmentGraph(g, { projectRoot, config }) }
      catch { continue }

      projectGraphs.push(aug)
      routes++

      const hasAuthn       = aug.nodes.some(n => n.type === 'authentication_gate')
      const hasAuthz       = aug.nodes.some(n => n.type === 'authorization_check')
      const hasTxn         = aug.nodes.some(n => n.type === 'transaction_boundary')
      const hasIso         = aug.nodes.some(n => n.type === 'unscoped_query')
      const listenerCount  = aug.nodes.filter(n => n.role === 'listener').length
      const isCtrl         = aug.nodes.some(n => n.type === 'controller_action')

      if (hasAuthn) authn++
      if (hasAuthz) authz++
      if (hasTxn)   txn++
      if (hasIso)   iso++
      if (isCtrl && !hasAuthn && !hasAuthz) noAuth++
      listeners += listenerCount
    }
  }

  const depIndex = buildDependencyIndex(projectGraphs)
  const dep      = indexStats(depIndex)
  const topSvc   = dep.topSymbols[0]

  console.log(`\n${name}`)
  console.log(`  routes=${routes}  authn=${authn}  authz=${authz}  txn=${txn}  iso=${iso}  no-auth=${noAuth}  listeners=${listeners}`)
  console.log(`  dep-index: ${dep.totalSymbols} symbols / ${dep.totalClasses} classes  top="${topSvc?.symbol ?? '—'}" (${topSvc?.routeCount ?? 0}x)`)

  totals.routes        += routes
  totals.authn         += authn
  totals.authz         += authz
  totals.txn           += txn
  totals.iso           += iso
  totals.noAuth        += noAuth
  totals.listenerNodes += listeners
}

console.log('\n' + '='.repeat(60))
console.log('CROSS-PROJECT TOTALS')
console.log('='.repeat(60))
console.log(`  Total routes   : ${totals.routes}`)
console.log(`  Auth-gated     : ${totals.authn} authn + ${totals.authz} authz`)
console.log(`  Txn routes     : ${totals.txn}`)
console.log(`  Unscoped query : ${totals.iso}`)
console.log(`  No-auth        : ${totals.noAuth}`)
console.log(`  Listener nodes : ${totals.listenerNodes}`)

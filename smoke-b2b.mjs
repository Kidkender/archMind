import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from './packages/laravel-parser/dist/index.js'
import { join } from 'path'

const projectRoot = 'C:/Users/Admin/Desktop/DuckCode/New folder/laravel-b2b-ecommerce'
const config = loadProjectConfig(projectRoot)
const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)

console.log(`Project: ${projectRoot}`)
console.log(`Route files found: ${routeFiles.length}`)
routeFiles.forEach(f => console.log(`  ${f}`))
console.log()

let totalRoutes = 0
let routesWithNodes = 0
const categories = {
  auth: [],
  txn: [],
  iso: [],
  svc: [],
  missing_auth: [],
}

for (const relFile of routeFiles) {
  let skeletons
  try {
    skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
  } catch (e) {
    console.log(`ERROR parsing ${relFile}: ${e.message}`)
    continue
  }

  totalRoutes += skeletons.length

  for (const g of skeletons) {
    let aug
    try {
      aug = augmentGraph(g, { projectRoot, config })
    } catch (e) {
      console.log(`ERROR augmenting ${g.entrypoint}: ${e.message}`)
      continue
    }

    const authNodes = aug.nodes.filter(n =>
      n.type === 'authorization_check' || n.type === 'authentication_gate' || n.type === 'policy'
    )
    const frNodes   = aug.nodes.filter(n => n.type === 'form_request')
    const svcNodes  = aug.nodes.filter(n => n.type === 'service_call')
    const txnNodes  = aug.nodes.filter(n => n.type === 'transaction_boundary')
    const wriNodes  = aug.nodes.filter(n => n.type === 'transactional_write')
    const escNodes  = aug.nodes.filter(n => n.type === 'transaction_escape')
    const qryNodes  = aug.nodes.filter(n => n.type.includes('query'))
    const permNodes = aug.nodes.filter(n => n.type === 'permission')

    const hasAuth     = authNodes.some(n => n.type === 'authentication_gate')
    const hasAuthzn   = authNodes.some(n => n.type === 'authorization_check' || n.type === 'policy')
    const hasTxn      = txnNodes.length > 0
    const hasIso      = qryNodes.some(n => n.type === 'unscoped_query')
    const hasSvc      = svcNodes.length > 0
    const noAuth      = !hasAuth && !hasAuthzn

    const hasInteresting = authNodes.length > 0 || txnNodes.length > 0 || svcNodes.length > 0

    if (hasInteresting) {
      routesWithNodes++

      const flags = [
        hasAuth    ? 'AUTHN' : '',
        hasAuthzn  ? 'AUTHZ' : '',
        hasTxn     ? 'TXN'   : '',
        hasIso     ? 'ISO'   : '',
        hasSvc     ? 'SVC'   : '',
        noAuth     ? '⚠ NO-AUTH' : '',
      ].filter(Boolean).join(' | ')

      console.log(`\n${aug.entrypoint}  [${flags}]  (${aug.nodes.length} nodes)`)
      authNodes.forEach(n => console.log(`  [${n.type.padEnd(20)}] ${n.symbol}`))
      permNodes.forEach(n => console.log(`  [permission           ] ${n.symbol}`))
      frNodes.forEach(n   => console.log(`  [form_request         ] ${n.symbol}`))
      svcNodes.forEach(n  => console.log(`  [service_call         ] ${n.symbol}  file=${n.file ?? 'UNRESOLVED'}`))
      txnNodes.forEach(n  => console.log(`  [transaction_boundary ] ${n.symbol}`))
      wriNodes.forEach(n  => console.log(`  [transactional_write  ] ${n.symbol}`))
      escNodes.forEach(n  => console.log(`  [transaction_escape   ] ${n.symbol}`))
      qryNodes.forEach(n  => console.log(`  [${n.type.padEnd(20)}] ${n.symbol}`))
    }

    // Categorize for summary
    if (hasTxn) categories.txn.push(aug.entrypoint)
    if (hasIso) categories.iso.push(aug.entrypoint)
    if (hasSvc && (hasAuth || hasAuthzn)) categories.auth.push(aug.entrypoint)
    if (hasSvc) categories.svc.push(aug.entrypoint)
    if (noAuth && aug.nodes.some(n => n.type === 'controller_action')) categories.missing_auth.push(aug.entrypoint)
  }
}

console.log('\n' + '='.repeat(70))
console.log('SUMMARY')
console.log('='.repeat(70))
console.log(`Total routes parsed : ${totalRoutes}`)
console.log(`Routes with nodes   : ${routesWithNodes}`)
console.log()
console.log(`Transaction routes  : ${categories.txn.length}`)
categories.txn.forEach(e => console.log(`  ${e}`))
console.log()
console.log(`Potential unscoped  : ${categories.iso.length}`)
categories.iso.forEach(e => console.log(`  ${e}`))
console.log()
console.log(`Auth+service routes : ${categories.auth.length}`)
console.log()
console.log(`Routes with NO auth : ${categories.missing_auth.length}`)
categories.missing_auth.forEach(e => console.log(`  ${e}`))

import { describe, test, expect } from "@jest/globals"
import { IR_NODE_TYPES, IR_EDGE_RELATIONS } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { parseExpressSources, type ParseExpressOptions } from "../adapter.js"

function graphs(files: Record<string, string>, opts: ParseExpressOptions = {}): IntermediateExecutionGraph[] {
  return parseExpressSources(Object.entries(files).map(([path, content]) => ({ path, content })), opts)
}

function graph(gs: IntermediateExecutionGraph[], entry: string): IntermediateExecutionGraph {
  const g = gs.find((x) => x.entrypoint === entry)
  if (!g) throw new Error(`no graph ${entry}; have ${gs.map((x) => x.entrypoint).join(", ")}`)
  return g
}

const symbolsOf = (g: IntermediateExecutionGraph, type: string) => g.nodes.filter((n) => n.type === type).map((n) => n.symbol)

describe("analyzeHandler — service calls", () => {
  const files = {
    "src/routes/user.route.js": `
      const express = require('express')
      const userController = require('../controllers/user.controller')
      const router = express.Router()
      router.post('/users', userController.createUser)
      module.exports = router
    `,
    "src/app.js": `
      const app = require('express')()
      app.use(require('./routes/user.route'))
    `,
    "src/controllers/user.controller.js": `
      const userService = require('../services/user.service')
      const pick = require('../utils/pick')
      const format = (u) => u
      const createUser = async (req, res) => {
        const filter = pick(req.body, ['name'])
        const user = await userService.createUser(filter)
        res.status(201).send(format(user))
      }
      module.exports = { createUser }
    `,
    "src/services/user.service.js": `
      const createUser = async (body) => body
      module.exports = { createUser }
    `,
    "src/utils/pick.js": `
      module.exports = (o, keys) => o
    `,
  }

  test("calls into a service module become ir:service_call nodes; utilities, local helpers and req/res do not", () => {
    const g = graph(graphs(files), "POST /users")
    expect(g.nodes.filter((n) => n.type === IR_NODE_TYPES.SERVICE_CALL)).toEqual([
      expect.objectContaining({ symbol: "userService::createUser", file: "src/services/user.service.js", line: 2 }),
    ])
    expect(g.edges).toContainEqual(expect.objectContaining({ from: "handler", relation: IR_EDGE_RELATIONS.CALLS }))
  })

  test("a class controller reaches its service through a constructor parameter property", () => {
    const g = graph(graphs({
      "src/app.ts": `
        import express from 'express'
        import { UserController } from './user.controller'
        import { UserService } from './user.service'
        const ctrl = new UserController(new UserService())
        const app = express()
        app.get('/users', ctrl.list.bind(ctrl))
      `,
      "src/user.controller.ts": `
        import { UserService } from './user.service'
        export class UserController {
          constructor(private readonly users: UserService) {}
          async list(req, res) {
            res.json(await this.users.findAll())
          }
        }
      `,
      "src/user.service.ts": `
        export class UserService {
          async findAll() { return [] }
        }
      `,
    }), "GET /users")
    expect(g.nodes.find((n) => n.id === "handler")).toMatchObject({ symbol: "ctrl.list", file: "src/user.controller.ts", line: 5 })
    expect(symbolsOf(g, IR_NODE_TYPES.SERVICE_CALL)).toEqual(["users::findAll"])
  })
})

describe("analyzeHandler — transactions", () => {
  test("ORM transactions in the handler or one call below it; a domain method named transaction is not one", () => {
    const gs = graphs({
      "app.js": `
        const express = require('express')
        const { sequelize } = require('./db')
        const orderService = require('./order.service')
        const app = express()
        app.post('/orders', async (req, res) => {
          await sequelize.transaction(async (t) => { await Order.create(req.body, { transaction: t }) })
          res.send()
        })
        app.post('/payments', async (req, res) => { await orderService.pay(req.body); res.send() })
        app.post('/wallet', async (req, res) => { wallet.transaction(5); res.send() })
        app.post('/mongo', async (req, res) => { const s = await mongoose.startSession(); await s.withTransaction(async () => {}); res.send() })
      `,
      "order.service.js": `
        const prisma = require('./prisma')
        exports.pay = async (body) => prisma.$transaction([prisma.payment.create({ data: body })])
      `,
    })
    expect(graph(gs, "POST /orders").nodes.find((n) => n.id === "txn")).toMatchObject({
      type: IR_NODE_TYPES.TXN_BOUNDARY, symbol: "sequelize.transaction", file: "app.js", line: 7,
    })
    expect(graph(gs, "POST /payments").nodes.find((n) => n.id === "txn")).toMatchObject({
      symbol: "prisma.$transaction", file: "order.service.js", line: 3,
    })
    expect(graph(gs, "POST /mongo").nodes.find((n) => n.id === "txn")?.symbol).toBe("s.withTransaction")
    expect(graph(gs, "POST /wallet").nodes.some((n) => n.id === "txn")).toBe(false)
  })

  test("a transaction on a handle from an ORM package counts whatever it is named", () => {
    const g = graph(graphs({
      "app.ts": `
        import express from 'express'
        import { DataSource } from 'typeorm'
        const store = new DataSource({ type: 'postgres' })
        const app = express()
        app.post('/x', async (req, res) => { await getManager().transaction(async (m) => {}); res.send() })
        app.post('/y', async (req, res) => { await orm.transaction(async (m) => {}); res.send() })
      `,
    }), "POST /x")
    expect(g.nodes.find((n) => n.id === "txn")?.symbol).toBe("getManager().transaction")
  })
})

describe("analyzeHandler — ownership", () => {
  test("a configured ownership source called by the handler or its service is an ir:authz_check", () => {
    const files = {
      "app.js": `
        const express = require('express')
        const svc = require('./note.service')
        const app = express()
        app.delete('/notes/:id', requireAuth, async (req, res) => {
          const me = await currentUser(req)
          await svc.remove(me, req.params.id)
          res.send()
        })
        app.put('/notes/:id', requireAuth, async (req, res) => { await svc.update(req); res.send() })
        app.get('/notes/:id', requireAuth, async (req, res) => { res.send() })
      `,
      "note.service.js": `
        exports.remove = async (me, id) => {}
        exports.update = async (req) => { const me = await currentUser(req) }
      `,
    }
    const gs = graphs(files, { ownershipSources: ["currentUser"] })

    const del = graph(gs, "DELETE /notes/:id")
    expect(del.nodes.find((n) => n.id === "ownership")).toMatchObject({
      type: IR_NODE_TYPES.AUTHZ_CHECK, symbol: "ownership:currentUser", file: "app.js", line: 6,
    })
    expect(graph(gs, "PUT /notes/:id").nodes.find((n) => n.id === "ownership")?.file).toBe("note.service.js")
    expect(graph(gs, "GET /notes/:id").nodes.some((n) => n.id === "ownership")).toBe(false)
    expect(graphs(files).every((g) => !g.nodes.some((n) => n.id === "ownership"))).toBe(true)
  })

  test("ownership and the transaction follow the handler in the precedes chain", () => {
    const [g] = graphs({
      "app.js": `
        const app = require('express')()
        app.post('/x', requireAuth, async (req, res) => {
          const me = currentUser(req)
          await db.transaction(async () => {})
        })
      `,
    }, { ownershipSources: ["currentUser"] })
    const chain = g.edges.filter((e) => e.relation === IR_EDGE_RELATIONS.PRECEDES).map((e) => `${e.from}->${e.to}`)
    expect(chain).toEqual(["mw_0->handler", "handler->ownership", "ownership->txn"])
  })
})

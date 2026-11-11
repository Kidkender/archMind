// Auth + transaction: two writes inside one TypeORM transaction.
import express from 'express'
import { requireAuth } from './auth'
import { dataSource } from './data-source'
import { Order } from './order.entity'
import { Payment } from './payment.entity'

const app = express()
app.use(express.json())

app.post('/orders', requireAuth, async (req, res) => {
  await dataSource.transaction(async (manager) => {
    const order = await manager.save(Order, req.body)
    await manager.save(Payment, { orderId: order.id, amount: req.body.total })
  })
  res.status(201).json({ created: true })
})

export default app

// Auth + validation: authenticated, then the request body is validated.
const express = require('express')
const { body } = require('express-validator')
const { requireAuth } = require('./auth')

const app = express()
app.use(express.json())

app.post('/tasks', requireAuth, body('title').isString().notEmpty(), (req, res) => {
  res.status(201).json({ created: true })
})

module.exports = app

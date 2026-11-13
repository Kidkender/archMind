// Auth only: a JWT-authenticated read, no authorization, no validation.
const express = require('express')
const { requireAuth } = require('./auth')

const app = express()
app.use(express.json())

const tasks = express.Router()
tasks.use(requireAuth)
tasks.get('/:id', (req, res) => {
  res.json({ id: req.params.id })
})

app.use('/tasks', tasks)

module.exports = app

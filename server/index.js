import express from 'express'
import cors    from 'cors'
import fs      from 'fs'
import path    from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app       = express()
const DB_PATH   = path.join(__dirname, '..', 'data', 'expenses.enc')

app.use(cors())
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }))
app.use(express.json())

// ensure data dir exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

// GET — download encrypted DB
app.get('/api/db', (req, res) => {
  if (!fs.existsSync(DB_PATH)) {
    return res.status(404).json({ error: 'No database yet' })
  }
  const data = fs.readFileSync(DB_PATH)
  res.setHeader('Content-Type', 'application/octet-stream')
  res.send(data)
})

// POST — save encrypted DB
app.post('/api/db', (req, res) => {
  fs.writeFileSync(DB_PATH, req.body)
  res.json({ ok: true, size: req.body.length })
})

// Check if server is reachable
app.get('/api/ping', (req, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3001
app.listen(PORT, '0.0.0.0', () => {
  console.log(`DB server running on http://0.0.0.0:${PORT}`)
})
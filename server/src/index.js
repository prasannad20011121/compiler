/**
 * browser-ide API — auth + project persistence ONLY.
 * There are no execution endpoints and there never will be:
 * all code runs client-side in the browser via WASM.
 */
import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import { connectDb } from './db.js';
import { authRouter } from './routes/auth.js';
import { projectsRouter } from './routes/projects.js';

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN?.split(',') ?? 'http://localhost:4200',
  }),
);
app.use(express.json({ limit: '5mb' })); // project file trees

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = process.env.PORT ?? 3000;
await connectDb();
app.listen(port, () => console.log(`browser-ide API listening on :${port}`));

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { Project } from '../models/Project.js';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function validFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) return false;
  let total = 0;
  for (const f of files) {
    if (typeof f?.path !== 'string' || typeof f?.content !== 'string') return false;
    if (f.path.includes('..') || f.path.startsWith('/')) return false;
    total += f.content.length;
  }
  return total <= MAX_TOTAL_BYTES;
}

/** List the caller's projects (metadata only). */
projectsRouter.get('/', async (req, res) => {
  const projects = await Project.find({ userId: req.userId })
    .sort({ updatedAt: -1 })
    .select('name updatedAt files.path');
  res.json(
    projects.map((p) => ({
      id: p._id,
      name: p.name,
      updatedAt: p.updatedAt,
      fileCount: p.files.length,
    })),
  );
});

/** Create or update (upsert by name) — the IDE's "Save to cloud". */
projectsRouter.post('/', async (req, res) => {
  const { name, files } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim() || !validFiles(files)) {
    return res.status(400).json({ error: 'name and a valid files array are required' });
  }
  const project = await Project.findOneAndUpdate(
    { userId: req.userId, name: name.trim() },
    { $set: { files } },
    { new: true, upsert: true },
  );
  res.json({ id: project._id, name: project.name, updatedAt: project.updatedAt });
});

/** Full project, for loading into the workspace. */
projectsRouter.get('/:id', async (req, res) => {
  const project = await Project.findOne({ _id: req.params.id, userId: req.userId });
  if (!project) return res.status(404).json({ error: 'not found' });
  res.json({ id: project._id, name: project.name, files: project.files });
});

projectsRouter.delete('/:id', async (req, res) => {
  const result = await Project.deleteOne({ _id: req.params.id, userId: req.userId });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

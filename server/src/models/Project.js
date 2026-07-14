import mongoose from 'mongoose';

const projectSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    files: [
      {
        _id: false,
        path: { type: String, required: true },
        content: { type: String, default: '' },
      },
    ],
  },
  { timestamps: true },
);

projectSchema.index({ userId: 1, name: 1 }, { unique: true });

export const Project = mongoose.model('Project', projectSchema);

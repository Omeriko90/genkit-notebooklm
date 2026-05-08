import { Request, Response, NextFunction } from 'express';
import { synthesize } from '../synthesis';
import { synthesisRequestSchema } from '../schemas/podcast';

export const synthesisController = {
  synthesize: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = synthesisRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ status: 'error', message: parsed.error.message });
      }

      try {
        const result = await synthesize(parsed.data);
        return res.json({ status: 'success', result });
      } catch (error: unknown) {
        return res.status(500).json({ status: 'error', message: 'Synthesis failed' });
      }
    } catch (error) {
      next(error);
    }
  }
}; 
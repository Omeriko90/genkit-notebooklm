import { Router } from 'express';
import { synthesisController } from '../controllers/synthesisController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

router.post('/', authMiddleware, synthesisController.synthesize);

export { router as synthesisRouter }; 
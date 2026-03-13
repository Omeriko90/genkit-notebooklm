import { Router } from 'express';
import { jobsController } from '../controllers/jobsController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

router.post('/create-users-podcasts',authMiddleware, jobsController.createUsersPodcasts);

export { router as jobsRouter };


import { Router } from 'express';
import { jobsController } from '../controllers/jobsController';

const router = Router();

router.post('/create-users-podcasts', jobsController.createUsersPodcasts);

export { router as jobsRouter };


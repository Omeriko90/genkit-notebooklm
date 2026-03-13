import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { synthesisRouter } from './routes/synthesis';
import { errorHandler } from './middleware/errorHandler';
import { jobsRouter } from './routes/jobs';
import { isExtractorHealthy } from './integrations/extractor';

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Routes
app.use('/api/synthesis', synthesisRouter);
app.use('/api/jobs', jobsRouter);
app.use('/health', (req, res) => {
  res.json({ message: 'OK' });
});

app.get('/health/full', async (req, res) => {
  const extractorHealthy = await isExtractorHealthy();
  const status = extractorHealthy ? 200 : 503;
  res.status(status).json({
    synthesis: 'OK',
    extractor: extractorHealthy ? 'OK' : 'unreachable',
  });
});

// Error handling
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 
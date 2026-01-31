import { Request, Response, NextFunction } from 'express';
import { prisma } from "../lib/prisma";



export const userController = {
  list: async (req: Request, res: Response) => {
    try {
      const users = await prisma.user.findMany();
      return res.json({ users });
    } catch (error) {
      return res.status(500).json({ message: error instanceof Error ? error.message : 'Unknown error occurred' });
    }
  }
};
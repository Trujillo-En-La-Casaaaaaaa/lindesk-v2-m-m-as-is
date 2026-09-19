import express from "express";
import type { Express } from "express";
import { createRouter, errorHandler, notFoundHandler } from "./router.js";
import type { HttpRouterDependencies } from "./router.js";

export type HttpServerDependencies = HttpRouterDependencies;

/**
 * Express 4 application, mounted exactly as the legacy process was: `express.json()` and
 * `express.urlencoded({extended:false})`, then the `/api/*` router, then a JSON 404 for everything
 * else. Only `/api/*` is served - the HTML pages now belong to `shopflow-web`.
 */
export function createApp({ useCases }: HttpServerDependencies): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(createRouter({ useCases }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

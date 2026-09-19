import { Router } from "express";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { createControllers } from "./controllers.js";
import type { HttpUseCases } from "./controllers.js";
import { mapErrorToResponse } from "./error-mapping.js";

export interface HttpRouterDependencies {
  useCases: HttpUseCases;
}

/**
 * The frozen `/api/*` surface: seven routes, no more. Anything else (including
 * `POST /api/orders/:id/cancel` and `PATCH /api/orders/:id`) falls through to the 404 handler, because
 * cancellation and order editing do not exist in this service.
 */
export function createRouter({ useCases }: HttpRouterDependencies): Router {
  const controllers = createControllers(useCases);
  const router = Router();

  router.get("/api/health", controllers.health);
  router.get("/api/products", controllers.listProducts);
  router.get("/api/products/:id", controllers.getProduct);
  router.post("/api/orders", controllers.createOrder);
  router.get("/api/orders/:id", controllers.getOrder);
  router.post("/api/orders/:id/ship", controllers.shipOrder);
  router.get("/api/notifications", controllers.listNotifications);

  return router;
}

/** Terminal 404 for every unmatched path, in the contract's `{"error":"<message>"}` envelope. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found" });
};

/** Final error handler: body-parser and other transport errors are mapped like use-case errors. */
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const { status, body } = mapErrorToResponse(error);
  res.status(status).json(body);
};

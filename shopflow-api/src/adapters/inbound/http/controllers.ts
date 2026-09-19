import type { Request, RequestHandler, Response } from "express";
import type { CreateOrderUseCase } from "../../../application/ports/in/create-order.js";
import type { GetOrderUseCase } from "../../../application/ports/in/get-order.js";
import type { GetProductUseCase } from "../../../application/ports/in/get-product.js";
import type { ListNotificationsUseCase } from "../../../application/ports/in/list-notifications.js";
import type { ListProductsUseCase } from "../../../application/ports/in/list-products.js";
import type { ShipOrderUseCase } from "../../../application/ports/in/ship-order.js";
import { mapErrorToResponse } from "./error-mapping.js";
import { parseCreateOrderBody, parsePathId } from "./request-validation.js";

/** The inbound ports the HTTP adapter drives; the adapter owns no business rule or message. */
export interface HttpUseCases {
  listProducts: ListProductsUseCase;
  getProduct: GetProductUseCase;
  createOrder: CreateOrderUseCase;
  getOrder: GetOrderUseCase;
  shipOrder: ShipOrderUseCase;
  listNotifications: ListNotificationsUseCase;
}

/**
 * Route handlers. They only parse input, call one use case and serialise the result; status codes and
 * messages come from the use cases (domain errors) and the error mapping. Every handler is wrapped so
 * a rejected promise becomes a mapped response instead of an unhandled rejection.
 */
export function createControllers(useCases: HttpUseCases) {
  return {
    /** `GET /api/health` -> `200 {"ok":true}`; touches neither the database nor the provider. */
    health: ((_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    }) as RequestHandler,

    listProducts: handle(async (_req, res) => {
      res.status(200).json(await useCases.listProducts.execute());
    }),

    getProduct: handle(async (req, res) => {
      res.status(200).json(await useCases.getProduct.execute(parsePathId(req.params.id)));
    }),

    createOrder: handle(async (req, res) => {
      const order = await useCases.createOrder.execute(parseCreateOrderBody(req.body));
      res.status(201).json(order);
    }),

    getOrder: handle(async (req, res) => {
      res.status(200).json(await useCases.getOrder.execute(parsePathId(req.params.id)));
    }),

    shipOrder: handle(async (req, res) => {
      res.status(200).json(await useCases.shipOrder.execute(parsePathId(req.params.id)));
    }),

    listNotifications: handle(async (_req, res) => {
      res.status(200).json(await useCases.listNotifications.execute());
    }),
  };
}

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

function handle(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      const { status, body } = mapErrorToResponse(error);
      res.status(status).json(body);
    });
  };
}

import express from "express";
import {
  health,
  listProductsApi,
  getProductApi,
  createOrderApi,
  getOrderApi,
  shipOrderApi,
  listNotificationsApi,
  homePage,
  productPage,
  newOrderPage,
  createOrderForm,
  orderPage,
  shipOrderForm,
} from "./controllers/shopController.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/api/health", health);
  app.get("/api/products", listProductsApi);
  app.get("/api/products/:id", getProductApi);
  app.post("/api/orders", createOrderApi);
  app.get("/api/orders/:id", getOrderApi);
  app.post("/api/orders/:id/ship", shipOrderApi);
  app.get("/api/notifications", listNotificationsApi);

  app.get("/", homePage);
  app.get("/products/:id", productPage);
  app.get("/orders/new", newOrderPage);
  app.post("/orders", createOrderForm);
  app.get("/orders/:id", orderPage);
  app.post("/orders/:id/ship", shipOrderForm);

  return app;
}

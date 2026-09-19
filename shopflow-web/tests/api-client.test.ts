import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createOrder, getOrder, getProduct, listProducts, shipOrder } from "../src/api/client";
import { ApiError, GENERIC_ERROR_MESSAGE, isNotFoundError, toErrorMessage } from "../src/api/errors";
import { DEFAULT_API_BASE, resolveApiBase } from "../src/config/runtime";
import { apiMock } from "./mocks/handlers";
import { server } from "./setupTests";

function failedRequest(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (error: unknown) => error,
  );
}

describe("api client", () => {
  it("calls the documented same-origin base path by default", async () => {
    expect(DEFAULT_API_BASE).toBe("/api");
    expect(resolveApiBase(undefined)).toBe("/api");
    expect(resolveApiBase("   ")).toBe("/api");
    expect(resolveApiBase("/api/")).toBe("/api");
    expect(resolveApiBase("/gateway/api")).toBe("/gateway/api");

    let requestedPath = "";
    server.use(
      http.get("/api/products", ({ request }) => {
        requestedPath = new URL(request.url).pathname;
        return HttpResponse.json([]);
      }),
    );

    await expect(listProducts()).resolves.toEqual([]);
    expect(requestedPath).toBe("/api/products");
  });

  it("GET /api/products returns the products as the API orders them", async () => {
    await expect(listProducts()).resolves.toEqual([
      { id: "prod-a", name: "Product A", priceCents: 1999, stock: 20 },
      { id: "prod-b", name: "Product B", priceCents: 999, stock: 10 },
    ]);
  });

  it("GET /api/products/:id returns the product and rejects with a 404 'Not found' error", async () => {
    await expect(getProduct("prod-a")).resolves.toEqual({
      id: "prod-a",
      name: "Product A",
      priceCents: 1999,
      stock: 20,
    });

    const error = await failedRequest(getProduct("does-not-exist"));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(isNotFoundError(error)).toBe(true);
    expect(toErrorMessage(error)).toBe("Not found");
  });

  it("POST /api/orders sends the legacy request body and returns the created order", async () => {
    const order = await createOrder({
      productId: "prod-a",
      quantity: 3,
      customerEmail: "buyer@example.com",
    });

    expect(order).toMatchObject({
      id: "order-1",
      customerEmail: "buyer@example.com",
      status: "CONFIRMED",
      productId: "prod-a",
      quantity: 3,
      totalCents: 5997,
      cancelledAt: null,
      cancellationReason: null,
    });
    expect(apiMock.products.find((product) => product.id === "prod-a")?.stock).toBe(17);
  });

  it("GET /api/orders/:id returns the order and rejects with a 404 'Not found' error", async () => {
    const order = apiMock.seedOrder({ quantity: 2 });

    await expect(getOrder(order.id)).resolves.toEqual(order);
    expect(isNotFoundError(await failedRequest(getOrder("does-not-exist")))).toBe(true);
  });

  it("POST /api/orders/:id/ship returns the SHIPPED order and refuses anything else", async () => {
    const confirmed = apiMock.seedOrder({ status: "CONFIRMED" });
    const shipped = await shipOrder(confirmed.id);

    expect(shipped.status).toBe("SHIPPED");
    expect(apiMock.shipCalls).toBe(1);

    const alreadyShipped = await failedRequest(shipOrder(confirmed.id));
    expect((alreadyShipped as ApiError).status).toBe(400);
    expect(toErrorMessage(alreadyShipped)).toBe("Cannot ship order");

    const unknown = await failedRequest(shipOrder("does-not-exist"));
    expect(toErrorMessage(unknown)).toBe("Cannot ship order");
  });

  it("extracts the API error message of 400, 404 and 500 responses verbatim", async () => {
    server.use(
      http.post("/api/orders", () => HttpResponse.json({ error: "Invalid order" }, { status: 400 })),
      http.post("/api/orders/:id/ship", () =>
        HttpResponse.json({ error: "Cannot ship order" }, { status: 400 }),
      ),
      http.get("/api/products/:id", () => HttpResponse.json({ error: "Not found" }, { status: 404 })),
      http.get("/api/orders/:id", () => HttpResponse.json({ error: "Storage failure" }, { status: 500 })),
    );

    const invalid = await failedRequest(
      createOrder({ productId: "prod-a", quantity: 1, customerEmail: "" }),
    );
    expect(invalid).toBeInstanceOf(ApiError);
    expect((invalid as ApiError).status).toBe(400);
    expect(toErrorMessage(invalid)).toBe("Invalid order");

    const refused = await failedRequest(shipOrder("order-1"));
    expect((refused as ApiError).status).toBe(400);
    expect(toErrorMessage(refused)).toBe("Cannot ship order");

    const missing = await failedRequest(getProduct("prod-z"));
    expect((missing as ApiError).status).toBe(404);
    expect(isNotFoundError(missing)).toBe(true);
    expect(toErrorMessage(missing)).toBe("Not found");

    const failure = await failedRequest(getOrder("order-1"));
    expect((failure as ApiError).status).toBe(500);
    expect(toErrorMessage(failure)).toBe("Storage failure");
  });

  it("falls back to the legacy generic text when no error message is present", async () => {
    server.use(http.get("/api/products", () => HttpResponse.text("", { status: 500 })));
    const emptyBody = await failedRequest(listProducts());
    expect((emptyBody as ApiError).status).toBe(500);
    expect((emptyBody as ApiError).message).toBe(GENERIC_ERROR_MESSAGE);

    server.use(http.get("/api/products", () => HttpResponse.json({ reason: "boom" }, { status: 500 })));
    const messageLess = await failedRequest(listProducts());
    expect((messageLess as ApiError).status).toBe(500);
    expect(toErrorMessage(messageLess)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("turns a transport failure into an ApiError that still has displayable text", async () => {
    server.use(http.get("/api/products", () => HttpResponse.error()));

    const error = await failedRequest(listProducts());
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect(toErrorMessage(error)).toBe(GENERIC_ERROR_MESSAGE);
  });
});

describe("api errors", () => {
  it("carries the response status and the legacy generic fallback message", () => {
    const error = new ApiError(500);

    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(error.status).toBe(500);
    expect(error.isNotFound).toBe(false);
    expect(isNotFoundError(error)).toBe(false);
    expect(toErrorMessage(new ApiError(404, "Not found"))).toBe("Not found");
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
    expect(toErrorMessage(undefined)).toBe(GENERIC_ERROR_MESSAGE);
  });
});

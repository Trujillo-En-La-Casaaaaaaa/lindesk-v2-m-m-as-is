import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../src/router";
import { apiMock, SEED_PRODUCTS } from "./mocks/handlers";
import { server } from "./setupTests";

function renderRoute(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

async function readRenderedJson(): Promise<string> {
  return await waitFor(() => {
    const pre = document.querySelector("pre");
    if (pre === null) {
      throw new Error("no order summary rendered yet");
    }
    return pre.textContent ?? "";
  });
}

async function renderNewOrderForm(): Promise<void> {
  renderRoute("/orders/new");
  await screen.findByRole("heading", { name: "Create order" });
  await screen.findByLabelText("Product");
}

describe("new order route (/orders/new)", () => {
  it("renders the legacy form: labelled product options, quantity 1 with min=1, required email", async () => {
    await renderNewOrderForm();

    const select = screen.getByLabelText("Product");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(SEED_PRODUCTS.map((product) => `${product.name} (stock ${product.stock})`));

    const quantity = screen.getByLabelText("Quantity");
    expect(quantity).toHaveValue(1);
    expect(quantity).toHaveAttribute("min", "1");

    expect(screen.getByLabelText("Email")).toBeRequired();
    expect(screen.getByRole("button", { name: "Place order" })).toBeInTheDocument();
  });

  it("creates the order, shows CONFIRMED with the SHIPPED action, ships it and reflects the new stock", async () => {
    const user = userEvent.setup();
    await renderNewOrderForm();

    await user.type(screen.getByLabelText("Email"), "buyer@example.com");
    await user.click(screen.getByRole("button", { name: "Place order" }));

    const created = await screen.findByRole("heading", { name: "Order order-1" });
    expect(created).toBeInTheDocument();

    // The order detail view renders the API's order object pretty-printed with 2-space indentation.
    const summary = await readRenderedJson();
    expect(summary).toBe(JSON.stringify(apiMock.orders[0], null, 2));
    expect(summary.split("\n")[1]).toBe('  "id": "order-1",');
    expect(summary).toContain('"status": "CONFIRMED"');
    expect(summary).toContain('"totalCents": 1999');
    expect(apiMock.notifications).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Mark SHIPPED" }));
    expect(await screen.findByText(/"status": "SHIPPED"/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark SHIPPED" })).not.toBeInTheDocument();

    // Home -> catalog: the inventory decrement caused by the order is visible as the changed stock.
    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(await screen.findByRole("heading", { name: "ShopFlow Catalog" })).toBeInTheDocument();
    const rows = await screen.findAllByRole("row");
    const productARow = within(rows[1]!);
    expect(productARow.getByText("19")).toBeInTheDocument();
    expect(apiMock.products.find((product) => product.id === "prod-a")?.stock).toBe(19);
  });

  it("shows 'Insufficient stock' and stays on the form when the API rejects the quantity", async () => {
    const user = userEvent.setup();
    await renderNewOrderForm();

    const quantity = screen.getByLabelText("Quantity");
    await user.clear(quantity);
    await user.type(quantity, "21");
    await user.type(screen.getByLabelText("Email"), "buyer@example.com");
    await user.click(screen.getByRole("button", { name: "Place order" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Insufficient stock");
    expect(screen.getByRole("heading", { name: "Create order" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Order / })).not.toBeInTheDocument();
    expect(apiMock.orders).toHaveLength(0);
  });

  it("shows the API's 'Invalid order' message without navigating away", async () => {
    server.use(
      http.post("/api/orders", () => HttpResponse.json({ error: "Invalid order" }, { status: 400 })),
    );
    const user = userEvent.setup();
    await renderNewOrderForm();

    await user.type(screen.getByLabelText("Email"), "buyer@example.com");
    await user.click(screen.getByRole("button", { name: "Place order" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid order");
    expect(screen.getByRole("heading", { name: "Create order" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Order / })).not.toBeInTheDocument();
  });

  it("shows the API's 'Product not found' message without navigating away", async () => {
    server.use(
      http.post("/api/orders", () =>
        HttpResponse.json({ error: "Product not found" }, { status: 404 }),
      ),
    );
    const user = userEvent.setup();
    await renderNewOrderForm();

    await user.type(screen.getByLabelText("Email"), "buyer@example.com");
    await user.click(screen.getByRole("button", { name: "Place order" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Product not found");
    expect(screen.getByRole("heading", { name: "Create order" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Order / })).not.toBeInTheDocument();
  });
});

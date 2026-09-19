import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../src/router";
import { apiMock } from "./mocks/handlers";
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

describe("order detail route (/orders/:id)", () => {
  it("renders the 'Order <id>' heading, the pretty-printed order and a Home link", async () => {
    const order = apiMock.seedOrder({ productId: "prod-a", quantity: 2, customerEmail: "buyer@example.com" });

    renderRoute(`/orders/${order.id}`);

    expect(await screen.findByRole("heading", { name: `Order ${order.id}` })).toBeInTheDocument();
    expect(await readRenderedJson()).toBe(JSON.stringify(order, null, 2));
    expect((await readRenderedJson()).split("\n")[1]).toBe(`  "id": "${order.id}",`);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  });

  it("shows 'Mark SHIPPED' for a CONFIRMED order and hides it after a successful ship call", async () => {
    const user = userEvent.setup();
    const order = apiMock.seedOrder({ status: "CONFIRMED" });

    renderRoute(`/orders/${order.id}`);

    const ship = await screen.findByRole("button", { name: "Mark SHIPPED" });
    expect(await readRenderedJson()).toContain('"status": "CONFIRMED"');

    await user.click(ship);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Mark SHIPPED" })).not.toBeInTheDocument();
    });
    expect(await readRenderedJson()).toContain('"status": "SHIPPED"');
    expect(apiMock.shipCalls).toBe(1);
  });

  it("never renders 'Mark SHIPPED' for a SHIPPED order and issues no ship request", async () => {
    const order = apiMock.seedOrder({ status: "SHIPPED" });

    renderRoute(`/orders/${order.id}`);

    expect(await readRenderedJson()).toContain('"status": "SHIPPED"');
    expect(screen.queryByRole("button", { name: "Mark SHIPPED" })).not.toBeInTheDocument();
    expect(apiMock.shipCalls).toBe(0);
  });

  it("never renders 'Mark SHIPPED' for a CANCELLED order and issues no ship request", async () => {
    const order = apiMock.seedOrder({ status: "CANCELLED" });

    renderRoute(`/orders/${order.id}`);

    expect(await readRenderedJson()).toContain('"status": "CANCELLED"');
    expect(screen.queryByRole("button", { name: "Mark SHIPPED" })).not.toBeInTheDocument();
    expect(apiMock.shipCalls).toBe(0);
  });

  it("displays the API's 'Cannot ship order' message when the transition is refused", async () => {
    server.use(
      http.post("/api/orders/:id/ship", () =>
        HttpResponse.json({ error: "Cannot ship order" }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    const order = apiMock.seedOrder({ status: "CONFIRMED" });

    renderRoute(`/orders/${order.id}`);

    await user.click(await screen.findByRole("button", { name: "Mark SHIPPED" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot ship order");
    expect(screen.getByRole("button", { name: "Mark SHIPPED" })).toBeInTheDocument();
    expect(await readRenderedJson()).toContain('"status": "CONFIRMED"');
  });

  it("renders the text 'Not found' for an unknown order id", async () => {
    renderRoute("/orders/does-not-exist");

    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(document.querySelector("pre")).toBeNull();
    expect(apiMock.shipCalls).toBe(0);
  });
});

import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../src/router";
import { SEED_PRODUCTS } from "./mocks/handlers";

function renderRoute(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe("catalog route (/)", () => {
  it("renders the 'ShopFlow Catalog' heading and the ID / Name / Price / Stock table", async () => {
    renderRoute("/");

    expect(await screen.findByRole("heading", { name: "ShopFlow Catalog" })).toBeInTheDocument();

    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(SEED_PRODUCTS.length + 1);
    expect(
      within(rows[0]!)
        .getAllByRole("columnheader")
        .slice(0, 4)
        .map((cell) => cell.textContent),
    ).toEqual(["ID", "Name", "Price", "Stock"]);
  });

  it("lists both products with the id, name, price and stock returned by GET /api/products", async () => {
    renderRoute("/");
    await screen.findByRole("heading", { name: "ShopFlow Catalog" });

    const rows = await screen.findAllByRole("row");
    SEED_PRODUCTS.forEach((product, index) => {
      const row = within(rows[index + 1]!);
      expect(row.getByText(product.id)).toBeInTheDocument();
      expect(row.getByText(product.name)).toBeInTheDocument();
      expect(row.getByText(`${product.priceCents} cents`)).toBeInTheDocument();
      expect(row.getByText(String(product.stock))).toBeInTheDocument();
    });
  });

  it("renders a 'View' link per product and a 'Create order' link to /orders/new", async () => {
    renderRoute("/");
    await screen.findByRole("heading", { name: "ShopFlow Catalog" });

    const rows = await screen.findAllByRole("row");
    SEED_PRODUCTS.forEach((product, index) => {
      expect(within(rows[index + 1]!).getByRole("link", { name: "View" })).toHaveAttribute(
        "href",
        `/products/${product.id}`,
      );
    });

    expect(screen.getByRole("link", { name: "Create order" })).toHaveAttribute("href", "/orders/new");
  });
});

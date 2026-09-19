import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../src/router";

function renderRoute(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe("product detail route (/products/:id)", () => {
  it("renders the product name, ID, price in cents and stock from GET /api/products/:id", async () => {
    renderRoute("/products/prod-a");

    expect(await screen.findByRole("heading", { name: "Product A" })).toBeInTheDocument();
    expect(screen.getByText("ID: prod-a")).toBeInTheDocument();
    expect(screen.getByText("Price: 1999 cents")).toBeInTheDocument();
    expect(screen.getByText("Stock: 20")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/");
  });

  it("renders the values of the second seeded product as well", async () => {
    renderRoute("/products/prod-b");

    expect(await screen.findByRole("heading", { name: "Product B" })).toBeInTheDocument();
    expect(screen.getByText("ID: prod-b")).toBeInTheDocument();
    expect(screen.getByText("Price: 999 cents")).toBeInTheDocument();
    expect(screen.getByText("Stock: 10")).toBeInTheDocument();
  });

  it("renders the text 'Not found' when the API answers 404", async () => {
    renderRoute("/products/does-not-exist");

    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

import { Route, Routes } from "react-router-dom";
import { CatalogRoute } from "./routes/CatalogRoute";
import { NewOrderRoute } from "./routes/NewOrderRoute";
import { NotFoundRoute } from "./routes/NotFoundRoute";
import { OrderRoute } from "./routes/OrderRoute";
import { ProductRoute } from "./routes/ProductRoute";

/**
 * The four legacy routes plus a client-side fallback. The legacy HTML form endpoints
 * (`POST /orders`, `POST /orders/:id/ship`) are replaced by calls to the JSON API from these views.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<CatalogRoute />} />
      <Route path="/products/:id" element={<ProductRoute />} />
      <Route path="/orders/new" element={<NewOrderRoute />} />
      <Route path="/orders/:id" element={<OrderRoute />} />
      <Route path="*" element={<NotFoundRoute />} />
    </Routes>
  );
}

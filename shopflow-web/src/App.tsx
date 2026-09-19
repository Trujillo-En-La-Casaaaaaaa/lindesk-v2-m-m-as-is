import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./router";

/** Application shell: a client-side router over the four legacy routes. */
export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

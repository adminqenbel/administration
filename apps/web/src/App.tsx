import { Navigate, Route, Routes } from "react-router-dom";
import { Shell, RequireModule } from "./Shell.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { Onboarding } from "./pages/Onboarding.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Bookings } from "./pages/Bookings.tsx";
import { Orders } from "./pages/Orders.tsx";
import { Customers } from "./pages/Customers.tsx";
import { Catalogue } from "./pages/Catalogue.tsx";
import { Resources } from "./pages/Resources.tsx";
import { Settings } from "./pages/Settings.tsx";
import { NotFound } from "./pages/NotFound.tsx";

export function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/onboarding" element={<Onboarding />} />
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="bookings" element={<RequireModule module="bookings" element={<Bookings />} />} />
        <Route path="orders" element={<RequireModule module="orders" element={<Orders />} />} />
        <Route path="customers" element={<Customers />} />
        <Route path="catalogue" element={<Catalogue />} />
        <Route path="resources" element={<Resources />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="/index.html" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

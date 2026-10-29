import LoginForm from "@/components/auth/LoginForm";
import { versionLabel, versionTitle } from "@/lib/version";

export default function LoginPage() {
  return (
    <div className="wrap">
      <div className="login-wrap">
        <div className="login-card">
          <p className="eyebrow">Fagron Hellas &middot; Αποθήκη</p>
          <h1>Σύνδεση</h1>
          <LoginForm />
          <p className="login-version" title={versionTitle}>
            Fagron WHS {versionLabel}
          </p>
        </div>
      </div>
    </div>
  );
}

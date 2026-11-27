import LoginForm from "@/components/auth/LoginForm";
import { versionLabel, versionTitle } from "@/lib/version";

export default function LoginPage() {
  return (
    <div className="wrap">
      <div className="login-wrap">
        <div className="login-card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="login-logo" src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/fagron-logo.svg`} alt="Fagron" width={150} height={34} />
          <p className="eyebrow">Fagron Hellas &middot; Αποθήκη (WHS)</p>
          <h1>Σύνδεση</h1>
          <LoginForm />
          <p className="login-version" title={versionTitle}>
            WHS {versionLabel}
          </p>
        </div>
      </div>
    </div>
  );
}

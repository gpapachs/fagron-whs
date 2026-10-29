import LoginForm from "@/components/auth/LoginForm";

export default function LoginPage() {
  return (
    <div className="wrap">
      <div className="login-wrap">
        <div className="login-card">
          <p className="eyebrow">Fagron Hellas &middot; Αποθήκη</p>
          <h1>Σύνδεση</h1>
          <LoginForm />
        </div>
      </div>
    </div>
  );
}

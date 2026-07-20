import "./globals.css";

export const metadata = {
  title: "Brevo Email Pipeline",
  description: "Send email to saved Apollo contacts via Brevo",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

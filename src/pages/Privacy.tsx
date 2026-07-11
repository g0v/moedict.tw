import { useEffect } from "react";

export function Privacy() {
  useEffect(() => {
    document.title = "隱私權政策 - 萌典";
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "20px",
        boxSizing: "border-box",
        background: "#f4f7fa",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          padding: "32px 24px",
          background: "#fff",
          borderRadius: 12,
          boxShadow: "0 4px 20px rgba(0,0,0,0.1)",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "1.8em", color: "#2c3e50", margin: "0 0 16px" }}>Privacy Policy</h1>
        <p style={{ fontSize: "1.05em", lineHeight: 1.6, color: "#555", margin: 0 }}>
          <strong>萌典—教育部華語、台語、客語辭典民間版</strong> (MoeDict) by Audrey Tang collects
          no private data. Your data will not be used in any way, because we do not collect any.
        </p>

        <hr
          style={{ width: 80, border: "none", borderTop: "2px solid #bdc3c7", margin: "28px auto" }}
        />

        <h1 style={{ fontSize: "1.8em", color: "#2c3e50", margin: "0 0 16px" }}>隱私權政策</h1>
        <p style={{ fontSize: "1.05em", lineHeight: 1.6, color: "#555", margin: 0 }}>
          由唐鳳開發的<strong>萌典—教育部華語、台語、客語辭典民間版</strong>
          不會蒐集個人資料。您的資料不會以任何方式被使用，因為我們根本不會蒐集任何資料。
        </p>
      </div>
    </div>
  );
}

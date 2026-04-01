import "dotenv/config";
import prisma from "./db/client.js";
import app from "./app.js";

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Spatial CMS running on http://localhost:${PORT}`);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

import { redirect } from "next/navigation";

export default function MindPalacePage() {
  redirect("/settings?tab=insights");
}

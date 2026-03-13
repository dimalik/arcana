import { redirect } from "next/navigation";

export default function RoomDetailPage() {
  redirect("/settings?tab=insights");
}

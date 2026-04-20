type ChatPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType?: string };

type ChatLikeMessage = {
  role: string;
  content?: string | ChatPart[];
  parts?: Array<{ type: string; text?: string }>;
};

export function extractChatMessageText(message: ChatLikeMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return (
    message.parts
      ?.filter(
        (part): part is { type: "text"; text: string } =>
          part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("") ?? ""
  );
}

export function normalizeChatHistory(
  messages: ChatLikeMessage[],
  options?: { maxMessages?: number },
): Array<{
  role: "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType?: string }>;
}> {
  const maxMessages = options?.maxMessages ?? 12;

  return messages.slice(-maxMessages).map((message) => {
    if (Array.isArray(message.content)) {
      const parts = message.content.map((part) => {
        if (part.type === "image") {
          const dataUrlMatch = part.image.match(/^data:([^;]+);base64,(.+)$/);
          return {
            type: "image" as const,
            image: dataUrlMatch ? dataUrlMatch[2] : part.image,
            mediaType: dataUrlMatch ? dataUrlMatch[1] : part.mediaType,
          };
        }
        return {
          type: "text" as const,
          text: part.text,
        };
      });
      return {
        role: message.role as "user" | "assistant",
        content: parts,
      };
    }

    return {
      role: message.role as "user" | "assistant",
      content: extractChatMessageText(message),
    };
  });
}

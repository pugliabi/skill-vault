/**
 * Choosing the Notion Skills data source (shared by POST /api/notion/data-source
 * and the setup guide's Finish job), and opening a connected NotionApi.
 */
import { NotionApi } from "./api.ts";
import { callToolJson, getNotionClient } from "./connection.ts";
import { writeNotionSettings } from "./store.ts";

export const LAST_EDITED_PROPERTY = "Last edited";
/** A Notion data source id: a UUID, with or without dashes. */
export const DATA_SOURCE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export interface NotionApiConn {
  api: NotionApi;
  close(): Promise<void>;
}

export async function openNotionApiAt(redirectUrl: string): Promise<NotionApiConn> {
  const client = await getNotionClient(redirectUrl);
  return {
    api: new NotionApi((name, args) => callToolJson(client, name, args)),
    close: () => client.close(),
  };
}

/** Save the chosen data source to <vault>/notion.json, adding "Last edited" first when asked. */
export async function chooseDataSource(
  api: Pick<NotionApi, "hasProperty" | "addLastEditedProperty">,
  vaultPath: string,
  choice: { id: string; name: string; add_last_edited: boolean },
): Promise<{ last_edited_property: string | null; warning?: string }> {
  let has = await api.hasProperty(choice.id, LAST_EDITED_PROPERTY, "last_edited_time");
  let warning: string | undefined;
  if (!has && choice.add_last_edited) {
    try {
      await api.addLastEditedProperty(choice.id, LAST_EDITED_PROPERTY);
      has = await api.hasProperty(choice.id, LAST_EDITED_PROPERTY, "last_edited_time");
      if (!has) warning = `Could not verify the "${LAST_EDITED_PROPERTY}" property after adding it`;
    } catch (err) {
      warning = `Could not add "${LAST_EDITED_PROPERTY}": ${(err as Error).message}`;
    }
  }
  const last_edited_property = has ? LAST_EDITED_PROPERTY : null;
  writeNotionSettings(vaultPath, { data_source_id: choice.id, data_source_name: choice.name, last_edited_property });
  return { last_edited_property, ...(warning ? { warning } : {}) };
}

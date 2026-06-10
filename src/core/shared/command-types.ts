export interface GlobalOptions {
  json?: boolean;
  quiet?: boolean;
  noChangedFields?: boolean;
  idOnly?: boolean;
  path?: string;
  noExtensions?: boolean;
  noPager?: boolean;
  profile?: boolean;
  defaultOutputFormat?: "toon" | "json";
}

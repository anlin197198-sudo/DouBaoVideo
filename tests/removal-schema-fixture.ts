export const removeV7Schema = `
DROP TRIGGER removal_account_created;
DROP TRIGGER removal_account_changed;
DROP TRIGGER removal_account_enable_guard;
DROP TRIGGER removal_account_delete_guard;
DROP TRIGGER removal_execution_insert_guard;
DROP TRIGGER removal_execution_update_guard;
DROP TRIGGER removal_execution_insert;
DROP TRIGGER removal_execution_update;
DROP TRIGGER removal_execution_delete;
DROP TABLE account_removal;
`;

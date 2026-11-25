# Rehearsing with a test room

A host can play a whole game alone before the event, with simulated players.

| Step | How |
| --- | --- |
| Create | „Raum erstellen“ with „Testraum“ ticked. It stays a test room; everyone in it sees the label |
| Add players | In the lobby: „Testspieler hinzufügen“, at most 30 per room; the field offers only what is still free. They are named „Testspieler 1“, „Testspieler 2“, … |
| Play | „Start“ as usual. Real members can join and roll too |

## What is different

| | Test room |
| --- | --- |
| Simulated players | Roll by themselves 6 seconds after their turn comes, with the same rules and host tools as everyone. A six pauses the game for them too: press „Weiter“ |
| Last player | A simulated last player keeps rolling until a six; it never takes the last place itself. With the last place given automatically (setting), it gets it at once |
| When they roll | Only while someone has the room open (a member or a guest) |
| Normal rooms | Refuse simulated players |

## Afterwards

Simulated players are users without Discord data. The daily cleanup deletes them together with their
test room, `RETENTION_DAYS` after its last activity ([data-and-deletion.md](data-and-deletion.md)).
In the lobby a host can also remove them one by one.

-- local-factory port: rewind is dropped (it existed only on Neon branching), so the list of
-- rewind branches it kept goes with it. Nothing reads or writes this table any more.
DROP TABLE IF EXISTS mc.rewind_branches;

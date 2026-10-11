use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP");

pub const TREE_SEED: &[u8] = b"tree";
pub const WORLD_ID: &[u8; 9] = b"astrix-v1";
pub const TREE_ID: &[u8; 7] = b"tree-01";
pub const TREE_PDA_SEEDS: &[&[u8]] = &[TREE_SEED, WORLD_ID, TREE_ID];
pub const FARM_SEED: &[u8] = b"farm";
pub const FARM_ID: &[u8; 7] = b"farm-01";
pub const FARM_PDA_SEEDS: &[&[u8]] = &[FARM_SEED, WORLD_ID, FARM_ID];
/// Minimal fencing counter for the consistency experiment: repeated,
/// owner-only increments, each consuming a nonce.
pub const COUNTER_SEED: &[u8] = b"counter";
pub const COUNTER_ID: &[u8; 8] = b"count-01";
pub const COUNTER_PDA_SEEDS: &[&[u8]] = &[COUNTER_SEED, WORLD_ID, COUNTER_ID];
/// Farm lifecycle stages. The program models only the consequential
/// construction transition; growth and harvest timing stay local.
pub const FARM_UNBUILT: u8 = 0;
pub const FARM_BUILT: u8 = 1;
pub const DEVNET_EU_VALIDATOR: Pubkey = pubkey!("MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e");

#[ephemeral]
#[program]
pub mod astrix_world {
    use super::*;

    pub fn initialize_tree(ctx: Context<InitializeTree>) -> Result<()> {
        let tree = &mut ctx.accounts.tree;
        tree.schema_version = 1;
        tree.world_id = *WORLD_ID;
        tree.tree_id = *TREE_ID;
        tree.owner = ctx.accounts.owner.key();
        tree.health = 1;
        tree.max_health = 1;
        tree.nonce = 0;
        tree.depleted = false;
        emit!(TreeInitialized {
            tree: tree.key(),
            owner: tree.owner,
            health: tree.health,
            nonce: tree.nonce,
        });
        Ok(())
    }

    /// The human owner is required as signer for the first slice. A session-key
    /// auth path can be added later after its limits are explicit and audited.
    pub fn chop_tree(ctx: Context<ChopTree>, expected_nonce: u64, action_id: [u8; 32]) -> Result<()> {
        let tree = &mut ctx.accounts.tree;
        require_keys_eq!(ctx.accounts.owner.key(), tree.owner, AstrixError::Unauthorized);
        require!(!tree.depleted && tree.health > 0, AstrixError::TreeAlreadyDepleted);
        require_eq!(tree.nonce, expected_nonce, AstrixError::StaleNonce);

        tree.health = 0;
        tree.depleted = true;
        tree.nonce = tree.nonce.checked_add(1).ok_or(AstrixError::NonceOverflow)?;
        emit!(TreeChopped {
            tree: tree.key(),
            owner: tree.owner,
            action_id,
            health: tree.health,
            nonce: tree.nonce,
        });
        Ok(())
    }

    pub fn delegate_tree(ctx: Context<DelegateTree>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        // Validate authority from a scoped borrow; the owned check outlives it.
        {
            let borrowed = ctx.accounts.tree.try_borrow_data()?;
            let mut slice: &[u8] = &borrowed;
            let tree = TreeState::try_deserialize(&mut slice)?;
            require_keys_eq!(owner, tree.owner, AstrixError::Unauthorized);
        }
        ctx.accounts.delegate_tree(
            &ctx.accounts.owner,
            &[TREE_SEED, WORLD_ID, TREE_ID],
            DelegateConfig {
                validator: Some(DEVNET_EU_VALIDATOR),
                ..Default::default()
            },
        )?;
        // After delegation the base account is owned by the delegation
        // program with state carried in the buffer/ER clone. There is nothing
        // to restore — attempting to write here fails (and must fail).
        Ok(())
    }

    pub fn commit_tree(ctx: Context<CommitTree>) -> Result<()> {
        require_keys_eq!(ctx.accounts.payer.key(), ctx.accounts.tree.owner, AstrixError::Unauthorized);
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.tree.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn commit_and_undelegate_tree(ctx: Context<CommitTree>) -> Result<()> {
        require_keys_eq!(ctx.accounts.payer.key(), ctx.accounts.tree.owner, AstrixError::Unauthorized);
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.tree.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Create the farm-01 construction record. The farm starts UNBUILT; only
    /// `build_farm` transitions it, exactly once.
    pub fn initialize_farm(ctx: Context<InitializeFarm>) -> Result<()> {
        let farm = &mut ctx.accounts.farm;
        farm.schema_version = 1;
        farm.world_id = *WORLD_ID;
        farm.farm_id = *FARM_ID;
        farm.authority = ctx.accounts.owner.key();
        farm.state = FARM_UNBUILT;
        farm.nonce = 0;
        farm.wood_spent = 0;
        emit!(FarmInitialized {
            farm: farm.key(),
            authority: farm.authority,
            nonce: farm.nonce,
        });
        Ok(())
    }

    /// Record farm construction. The human authority signs; the program
    /// enforces identity, single construction, and replay protection. It does
    /// NOT independently verify the local wood balance — the local governance
    /// layer deducts and commits the spent amount, which is recorded here as
    /// evidence, not re-derived.
    pub fn build_farm(
        ctx: Context<BuildFarm>,
        expected_nonce: u64,
        action_id: [u8; 32],
        wood_spent: u8,
    ) -> Result<()> {
        let farm = &mut ctx.accounts.farm;
        require_keys_eq!(ctx.accounts.owner.key(), farm.authority, AstrixError::Unauthorized);
        require!(farm.state == FARM_UNBUILT, AstrixError::FarmAlreadyBuilt);
        require_eq!(farm.nonce, expected_nonce, AstrixError::StaleNonce);

        farm.state = FARM_BUILT;
        farm.wood_spent = wood_spent;
        farm.nonce = farm.nonce.checked_add(1).ok_or(AstrixError::NonceOverflow)?;
        emit!(FarmBuilt {
            farm: farm.key(),
            authority: farm.authority,
            action_id,
            wood_spent: farm.wood_spent,
            nonce: farm.nonce,
        });
        Ok(())
    }

    pub fn delegate_farm(ctx: Context<DelegateFarm>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        // Validate authority from a scoped borrow; the owned check outlives it.
        {
            let borrowed = ctx.accounts.farm.try_borrow_data()?;
            let mut slice: &[u8] = &borrowed;
            let farm = FarmState::try_deserialize(&mut slice)?;
            require_keys_eq!(owner, farm.authority, AstrixError::Unauthorized);
        }
        ctx.accounts.delegate_farm(
            &ctx.accounts.owner,
            &[FARM_SEED, WORLD_ID, FARM_ID],
            DelegateConfig {
                validator: Some(DEVNET_EU_VALIDATOR),
                ..Default::default()
            },
        )?;
        // See delegate_tree: post-delegation the base account belongs to the
        // delegation program; writing it back would (and must) fail.
        Ok(())
    }

    pub fn commit_farm(ctx: Context<CommitFarm>) -> Result<()> {
        require_keys_eq!(ctx.accounts.payer.key(), ctx.accounts.farm.authority, AstrixError::Unauthorized);
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.farm.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn commit_and_undelegate_farm(ctx: Context<CommitFarm>) -> Result<()> {
        require_keys_eq!(ctx.accounts.payer.key(), ctx.accounts.farm.authority, AstrixError::Unauthorized);
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.farm.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Consistency-experiment counter: initialize count and nonce to zero.
    pub fn initialize_counter(ctx: Context<InitializeCounter>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.schema_version = 1;
        counter.world_id = *WORLD_ID;
        counter.counter_id = *COUNTER_ID;
        counter.authority = ctx.accounts.owner.key();
        counter.count = 0;
        counter.nonce = 0;
        emit!(CounterInitialized {
            counter: counter.key(),
            authority: counter.authority,
        });
        Ok(())
    }

    /// Increment the counter, consuming one nonce per call. The nonce is the
    /// fencing token: any party can verify contiguity, and replays of an old
    /// expected_nonce fail closed.
    pub fn increment_counter(ctx: Context<IncrementCounter>, expected_nonce: u64) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        require_keys_eq!(ctx.accounts.owner.key(), counter.authority, AstrixError::Unauthorized);
        require_eq!(counter.nonce, expected_nonce, AstrixError::StaleNonce);
        counter.count = counter.count.checked_add(1).ok_or(AstrixError::NonceOverflow)?;
        counter.nonce = counter.nonce.checked_add(1).ok_or(AstrixError::NonceOverflow)?;
        emit!(CounterIncremented {
            counter: counter.key(),
            count: counter.count,
            nonce: counter.nonce,
        });
        Ok(())
    }

    pub fn delegate_counter(ctx: Context<DelegateCounter>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        // Validate authority from a scoped borrow; the owned check outlives it.
        {
            let borrowed = ctx.accounts.counter.try_borrow_data()?;
            let mut slice: &[u8] = &borrowed;
            let counter = CounterState::try_deserialize(&mut slice)?;
            require_keys_eq!(owner, counter.authority, AstrixError::Unauthorized);
        }
        ctx.accounts.delegate_counter(
            &ctx.accounts.owner,
            &[COUNTER_SEED, WORLD_ID, COUNTER_ID],
            DelegateConfig {
                validator: Some(DEVNET_EU_VALIDATOR),
                ..Default::default()
            },
        )?;
        // See delegate_tree: post-delegation the base account belongs to the
        // delegation program; writing it back would (and must) fail.
        Ok(())
    }

    pub fn commit_counter(ctx: Context<CommitCounter>) -> Result<()> {
        require_keys_eq!(ctx.accounts.payer.key(), ctx.accounts.counter.authority, AstrixError::Unauthorized);
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn commit_and_undelegate_counter(ctx: Context<CommitCounter>) -> Result<()> {
        require_keys_eq!(ctx.accounts.payer.key(), ctx.accounts.counter.authority, AstrixError::Unauthorized);
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeTree<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + TreeState::INIT_SPACE,
        seeds = [TREE_SEED, WORLD_ID, TREE_ID],
        bump
    )]
    pub tree: Account<'info, TreeState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ChopTree<'info> {
    #[account(mut, seeds = [TREE_SEED, WORLD_ID, TREE_ID], bump, constraint = tree.schema_version == 1 @ AstrixError::InvalidSchema, constraint = tree.world_id == *WORLD_ID @ AstrixError::InvalidWorld, constraint = tree.tree_id == *TREE_ID @ AstrixError::InvalidTree)]
    pub tree: Account<'info, TreeState>,
    pub owner: Signer<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateTree<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Seed/owner constraints and SDK `del` CPI validate this PDA.
    #[account(mut, del, seeds = [TREE_SEED, WORLD_ID, TREE_ID], bump)]
    pub tree: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitTree<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TREE_SEED, WORLD_ID, TREE_ID], bump, constraint = tree.schema_version == 1 @ AstrixError::InvalidSchema, constraint = tree.world_id == *WORLD_ID @ AstrixError::InvalidWorld, constraint = tree.tree_id == *TREE_ID @ AstrixError::InvalidTree, constraint = tree.owner == payer.key() @ AstrixError::Unauthorized)]
    pub tree: Account<'info, TreeState>,
}

#[derive(Accounts)]
pub struct InitializeFarm<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + FarmState::INIT_SPACE,
        seeds = [FARM_SEED, WORLD_ID, FARM_ID],
        bump
    )]
    pub farm: Account<'info, FarmState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuildFarm<'info> {
    #[account(mut, seeds = [FARM_SEED, WORLD_ID, FARM_ID], bump, constraint = farm.schema_version == 1 @ AstrixError::InvalidSchema, constraint = farm.world_id == *WORLD_ID @ AstrixError::InvalidWorld, constraint = farm.farm_id == *FARM_ID @ AstrixError::InvalidFarm)]
    pub farm: Account<'info, FarmState>,
    pub owner: Signer<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateFarm<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Seed/owner constraints and SDK `del` CPI validate this PDA.
    #[account(mut, del, seeds = [FARM_SEED, WORLD_ID, FARM_ID], bump)]
    pub farm: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitFarm<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [FARM_SEED, WORLD_ID, FARM_ID], bump, constraint = farm.schema_version == 1 @ AstrixError::InvalidSchema, constraint = farm.world_id == *WORLD_ID @ AstrixError::InvalidWorld, constraint = farm.farm_id == *FARM_ID @ AstrixError::InvalidFarm, constraint = farm.authority == payer.key() @ AstrixError::Unauthorized)]
    pub farm: Account<'info, FarmState>,
}

#[account]
#[derive(InitSpace)]
pub struct TreeState {
    pub schema_version: u8,
    pub world_id: [u8; 9],
    pub tree_id: [u8; 7],
    pub owner: Pubkey,
    pub health: u8,
    pub max_health: u8,
    pub nonce: u64,
    pub depleted: bool,
}

#[event]
pub struct TreeInitialized {
    pub tree: Pubkey,
    pub owner: Pubkey,
    pub health: u8,
    pub nonce: u64,
}

#[event]
pub struct TreeChopped {
    pub tree: Pubkey,
    pub owner: Pubkey,
    pub action_id: [u8; 32],
    pub health: u8,
    pub nonce: u64,
}

#[account]
#[derive(InitSpace)]
pub struct FarmState {
    pub schema_version: u8,
    pub world_id: [u8; 9],
    pub farm_id: [u8; 7],
    pub authority: Pubkey,
    pub state: u8,
    pub nonce: u64,
    pub wood_spent: u8,
}

#[event]
pub struct FarmInitialized {
    pub farm: Pubkey,
    pub authority: Pubkey,
    pub nonce: u64,
}

#[event]
pub struct FarmBuilt {
    pub farm: Pubkey,
    pub authority: Pubkey,
    pub action_id: [u8; 32],
    pub wood_spent: u8,
    pub nonce: u64,
}

#[account]
#[derive(InitSpace)]
pub struct CounterState {
    pub schema_version: u8,
    pub world_id: [u8; 9],
    pub counter_id: [u8; 8],
    pub authority: Pubkey,
    pub count: u64,
    pub nonce: u64,
}

#[event]
pub struct CounterInitialized {
    pub counter: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct CounterIncremented {
    pub counter: Pubkey,
    pub count: u64,
    pub nonce: u64,
}

#[derive(Accounts)]
pub struct InitializeCounter<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + CounterState::INIT_SPACE,
        seeds = [COUNTER_SEED, WORLD_ID, COUNTER_ID],
        bump
    )]
    pub counter: Account<'info, CounterState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct IncrementCounter<'info> {
    #[account(mut, seeds = [COUNTER_SEED, WORLD_ID, COUNTER_ID], bump, constraint = counter.schema_version == 1 @ AstrixError::InvalidSchema, constraint = counter.world_id == *WORLD_ID @ AstrixError::InvalidWorld, constraint = counter.counter_id == *COUNTER_ID @ AstrixError::InvalidCounter)]
    pub counter: Account<'info, CounterState>,
    pub owner: Signer<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateCounter<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Seed/owner constraints and SDK `del` CPI validate this PDA.
    #[account(mut, del, seeds = [COUNTER_SEED, WORLD_ID, COUNTER_ID], bump)]
    pub counter: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [COUNTER_SEED, WORLD_ID, COUNTER_ID], bump, constraint = counter.schema_version == 1 @ AstrixError::InvalidSchema, constraint = counter.world_id == *WORLD_ID @ AstrixError::InvalidWorld, constraint = counter.counter_id == *COUNTER_ID @ AstrixError::InvalidCounter, constraint = counter.authority == payer.key() @ AstrixError::Unauthorized)]
    pub counter: Account<'info, CounterState>,
}

#[error_code]
pub enum AstrixError {
    #[msg("Only the tree owner can authorize this operation.")]
    Unauthorized,
    #[msg("This tree has already been depleted.")]
    TreeAlreadyDepleted,
    #[msg("The action nonce is stale or was already consumed.")]
    StaleNonce,
    #[msg("The tree action nonce overflowed.")]
    NonceOverflow,
    #[msg("World ID is invalid.")]
    InvalidWorld,
    #[msg("Tree ID is invalid.")]
    InvalidTree,
    #[msg("Farm ID is invalid.")]
    InvalidFarm,
    #[msg("Counter ID is invalid.")]
    InvalidCounter,
    #[msg("This farm has already been built.")]
    FarmAlreadyBuilt,
    #[msg("Tree state schema version is unsupported.")]
    InvalidSchema,
}

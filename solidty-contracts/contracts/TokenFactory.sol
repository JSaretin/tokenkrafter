// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

import "./shared/TokenInterfaces.sol";
import "./shared/DexInterfaces.sol";
import "./tokens/BasicToken.sol";
import "./tokens/TaxableToken.sol";

// =============================================================
// LAUNCHPAD INTERFACE (minimal, for fee queries)
// =============================================================

interface ILaunchpadFee {
    function launchFee() external view returns (uint256);
}

interface IAffiliateReporter {
    function report(address user, address ref, uint256 platformFee) external;
}

// =============================================================
// TOKEN FACTORY
// =============================================================

/// @title TokenFactory
/// @notice Creates ERC20 tokens via EIP-1167 minimal proxies (Clones) with
///         USDT-only fee collection. Multi-token / native fee support and
///         on-the-fly conversion were removed: the PlatformRouter is now the
///         only place that swaps user input into USDT before paying the
///         factory, so this contract no longer needs to know about prices,
///         payment tokens, or DEX paths. The DEX router is still kept for
///         tax processing (swapping accumulated tax tokens into USDT).
contract TokenFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // =============================================================
    // CUSTOM ERRORS
    // =============================================================

    error InvalidAddress();
    error InvalidTokenType();
    error ImplementationNotSet();
    error TransferFailed();
    error CircularReferral();
    error NoRewards();
    error NoBalance();
    error InvalidParams();
    error MaxLevelsExceeded();
    error TotalExceedsMax();
    error NotFactoryToken();
    error NotAuthorizedRouter();
    error InvalidPath();

    // =============================================================
    // STRUCTS
    // =============================================================

    /// @notice Metadata stored for each created token.
    struct TokenInfo {
        address creator;
        bool isMintable;
        bool isTaxable;
        bool isPartnership;
    }

    /// @notice Full token-view returned by `getTokensInfo`. Combines factory-side
    ///         metadata with token-side ERC20 fields so the explore page can
    ///         render a token row from one RPC call instead of N+1.
    struct TokenView {
        address tokenAddress;
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        address creator;
        bool isMintable;
        bool isTaxable;
        bool isPartnership;
    }

    /// @notice Parameters for creating a new token. `bases` are the DEX base
    ///         tokens for which the token implementation should pre-create
    ///         pairs at init time (e.g. WBNB, USDT). Creator-supplied — the
    ///         factory does not maintain a base-token allowlist.
    struct CreateTokenParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint8 decimals;
        bool isTaxable;
        bool isMintable;
        bool isPartner;
        address[] bases;
    }

    /// @notice Daily statistics snapshot.
    struct DayStats {
        uint256 basic;
        uint256 mintable;
        uint256 taxable;
        uint256 taxMintable;
        uint256 partner;
        uint256 partnerMint;
        uint256 partnerTax;
        uint256 partnerTaxMint;
        uint256 totalTokens;
        uint256 totalFeeUsdt;
    }

    // =============================================================
    // EVENTS
    // =============================================================

    event TokenCreated(
        address indexed creator,
        address indexed tokenAddress,
        uint8 tokenType,
        string name,
        string symbol,
        uint256 totalSupply,
        uint8 decimals,
        uint256 fee,
        address referrer
    );
    event ImplementationUpdated(uint8 indexed tokenType, address impl);
    event TaxProcessed(address indexed token, uint256 amountIn, uint256 amountOut);
    event TaxProcessFailed(address indexed token, uint256 amount);
    event TaxAccumulated(address indexed token, uint256 balance);
    event ReferralRecorded(address indexed creator, address indexed referrer);
    event ReferralRewardDistributed(address indexed referrer, uint256 amount, uint8 level);
    event ReferralRewardClaimed(address indexed user, uint256 amount);
    event PlatformWalletUpdated(address indexed oldWallet, address indexed newWallet);

    // =============================================================
    // STATE
    // =============================================================

    /// @notice DEX router used for tax-processing swaps. Not used for fees.
    IUniswapV2Router02 public dexRouter;

    /// @notice Stablecoin all fees are denominated in.
    address public usdt;

    /// @notice Implementation contract address per token type (0..7).
    mapping(uint8 => address) public implementations;

    /// @notice Creation fee in USDT for each token type (0..7).
    mapping(uint8 => uint256) public creationFee;

    /// @dev Mapping of creator to their created token addresses.
    mapping(address => address[]) private createdTokens;

    /// @notice Metadata for each token created by this factory.
    mapping(address => TokenInfo) public tokenInfo;

    /// @notice Total tokens created across all types.
    uint256 public totalTokensCreated;

    /// @dev Global ordered list of all created token addresses.
    address[] private _allTokens;

    /// @notice Per-creator nonce used for deterministic salt computation.
    mapping(address => uint256) public creatorNonce;

    /// @notice Number of tokens created per type key (0..7).
    mapping(uint8 => uint256) public tokensCreatedByType;

    /// @notice Slippage tolerance (bps) for tax swaps. Default 500 = 5%.
    uint256 public taxSlippageBps = 500;

    // =============================================================
    // REFERRALS (USDT only)
    // =============================================================

    /// @notice Maps a user to their referrer.
    mapping(address => address) public referrals;

    /// @notice Number of referral levels to walk up the chain (default 3).
    uint8 public referralLevels = 3;

    /// @notice When true, rewards are sent immediately on token creation.
    bool public autoDistributeReward = true;

    /// @notice Reward percentage per referral level in basis points.
    uint256[] public referralPercents;

    /// @notice Number of direct referrals per referrer.
    mapping(address => uint256) public totalReferred;

    /// @notice Total USDT rewards earned per referrer (lifetime).
    mapping(address => uint256) public totalEarned;

    /// @notice Claimable USDT reward balance per user.
    mapping(address => uint256) public pendingRewards;

    /// @notice Sum of all pending USDT rewards across all users.
    uint256 public totalPendingRewards;

    // =============================================================
    // DAILY STATS
    // =============================================================

    mapping(uint256 => DayStats) public dailyStats;
    uint256 public totalFeeEarnedUsdt;

    // =============================================================
    // PLATFORM
    // =============================================================

    address public authorizedRouter;

    /// @notice Shared platform Affiliate contract. address(0) leaves the
    ///         legacy multi-level referral path active. Setting this address
    ///         additionally credits the new Affiliate on every creation fee.
    address public affiliate;
    event AffiliateUpdated(address indexed previous, address indexed current);

    /// @notice Owner-only. Points at the (new) Affiliate contract.
    function setAffiliate(address aff) external onlyOwner {
        emit AffiliateUpdated(affiliate, aff);
        affiliate = aff;
    }
    address public platformWallet;

    // =============================================================
    // PARTNER DEFAULT BASES
    // =============================================================

    /// @dev Base tokens (e.g. USDT, WBNB) that the factory force-merges into
    ///      `bases[]` for every partner-variant token. Non-partner tokens are
    ///      free to pass any bases (or none) — only partner tokens get the
    ///      platform-mandated bases injected, because partner tokens earn the
    ///      platform an ongoing 1% fee and we want guaranteed pools on the
    ///      bases that drive that revenue.
    address[] private _defaultPartnerBases;
    mapping(address => bool) public isDefaultPartnerBase;

    /// @dev Hard cap on the default partner base list. Prevents an
    ///      unbounded list from making partner-token creation prohibitively
    ///      expensive via the O(n²) dedupe loop in `_sanitizeBases`.
    uint256 public constant MAX_DEFAULT_PARTNER_BASES = 8;

    // =============================================================
    // CONSTRUCTOR
    // =============================================================

    constructor(
        address usdt_,
        address dexRouter_,
        address platformWallet_
    ) Ownable(msg.sender) {
        if (usdt_ == address(0)) revert InvalidAddress();
        if (dexRouter_ == address(0)) revert InvalidAddress();
        if (platformWallet_ == address(0)) revert InvalidAddress();

        platformWallet = platformWallet_;
        usdt = usdt_;
        dexRouter = IUniswapV2Router02(dexRouter_);

        uint8 _usdtDecimals = ERC20(usdt_).decimals();

        creationFee[0] = 5 * 10 ** _usdtDecimals;     // Basic
        creationFee[1] = 10 * 10 ** _usdtDecimals;    // Mintable
        creationFee[2] = 10 * 10 ** _usdtDecimals;    // Taxable
        creationFee[3] = 15 * 10 ** _usdtDecimals;    // Tax + Mint
        creationFee[4] = 100 * 10 ** _usdtDecimals;   // Partner
        creationFee[5] = 120 * 10 ** _usdtDecimals;   // Partner + Mint
        creationFee[6] = 120 * 10 ** _usdtDecimals;   // Partner + Tax
        creationFee[7] = 150 * 10 ** _usdtDecimals;   // Partner + Tax + Mint

        // Default referral split: 5% / 3% / 2%.
        referralPercents.push(500);
        referralPercents.push(300);
        referralPercents.push(200);
    }

    // =============================================================
    // INTERNAL HELPERS
    // =============================================================

    /// @dev Computes the token type key from feature flags. partner=4, taxable=2, mintable=1.
    function _tokenTypeKey(bool isTaxable, bool isMintable, bool isPartner)
        internal pure returns (uint8)
    {
        return uint8((isPartner ? 4 : 0) | (isTaxable ? 2 : 0) | (isMintable ? 1 : 0));
    }

    /// @dev Pulls `amount` USDT from msg.sender. Caller is the immediate
    ///      msg.sender (creator for direct calls, router for routerCreateToken).
    function _collectFee(uint256 amount) internal {
        if (amount == 0) return;
        IERC20(usdt).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @dev Credits the shared Affiliate contract for this fee. No-op if no
    ///      Affiliate is set. try/catch wrap so a paused Affiliate never
    ///      bricks token creation. Lazy-init the USDT approval the first
    ///      time we need to reach a given Affiliate address.
    function _reportAffiliate(address user, address ref, uint256 fee) internal {
        address aff = affiliate;
        if (aff == address(0) || fee == 0) return;
        if (IERC20(usdt).allowance(address(this), aff) < fee) {
            IERC20(usdt).forceApprove(aff, type(uint256).max);
        }
        try IAffiliateReporter(aff).report(user, ref, fee) {} catch {}
    }

    /// @dev Builds the final bases[] passed to the token's initialize().
    ///      Always strips zero/self entries and dedupes. For partner-variant
    ///      tokens the platform's default partner bases are force-merged in,
    ///      so a creator who passes [] (or omits USDT/WBNB) still ends up
    ///      with pools on the bases that earn the platform its 1% fee.
    ///      Non-partner tokens are passed through untouched — creators are
    ///      free to pick whatever DEX bases they like.
    function _sanitizeBases(address[] calldata bases, address self, bool isPartner)
        internal view returns (address[] memory clean)
    {
        uint256 inLen = bases.length;
        uint256 defaultsLen = isPartner ? _defaultPartnerBases.length : 0;
        address[] memory tmp = new address[](inLen + defaultsLen);
        uint256 count;

        // Caller-supplied bases first
        for (uint256 i; i < inLen;) {
            address b = bases[i];
            if (b != address(0) && b != self) {
                bool dup;
                for (uint256 j; j < count;) {
                    if (tmp[j] == b) { dup = true; break; }
                    unchecked { ++j; }
                }
                if (!dup) tmp[count++] = b;
            }
            unchecked { ++i; }
        }

        // Force-merge platform defaults for partner variants
        for (uint256 i; i < defaultsLen;) {
            address b = _defaultPartnerBases[i];
            if (b != address(0) && b != self) {
                bool dup;
                for (uint256 j; j < count;) {
                    if (tmp[j] == b) { dup = true; break; }
                    unchecked { ++j; }
                }
                if (!dup) tmp[count++] = b;
            }
            unchecked { ++i; }
        }

        clean = new address[](count);
        for (uint256 i; i < count;) { clean[i] = tmp[i]; unchecked { ++i; } }
    }

    /// @dev Records the referral relationship and (if enabled) walks the
    ///      chain distributing USDT rewards at each level. All amounts in USDT.
    function _processReferral(
        address creator,
        address referral,
        uint256 feeUsdt
    ) internal {
        if (referral == address(0) || referral == creator) return;

        // Walk the existing chain to detect cycles.
        address current = referral;
        uint256 maxWalk = uint256(referralLevels) * 2;
        if (maxWalk < 10) maxWalk = 10;
        for (uint256 j = 0; j < maxWalk; j++) {
            if (current == address(0)) break;
            if (current == creator) revert CircularReferral();
            current = referrals[current];
        }

        // Record the relationship if creator doesn't already have one.
        if (referrals[creator] == address(0)) {
            referrals[creator] = referral;
            totalReferred[referral]++;
            emit ReferralRecorded(creator, referral);
        }

        if (feeUsdt == 0) return;

        // Walk upward distributing rewards.
        address ref = referrals[creator];
        uint8 levels = referralLevels;
        uint256 percentsLen = referralPercents.length;

        for (uint8 i = 0; i < levels;) {
            if (ref == address(0)) break;
            if (i >= percentsLen) break;

            uint256 reward = (feeUsdt * referralPercents[i]) / 10000;
            if (reward > 0) {
                if (autoDistributeReward) {
                    // Try direct USDT transfer; on failure, accrue.
                    try IERC20(usdt).transfer(ref, reward) returns (bool ok) {
                        if (!ok) {
                            pendingRewards[ref] += reward;
                            totalPendingRewards += reward;
                        }
                    } catch {
                        pendingRewards[ref] += reward;
                        totalPendingRewards += reward;
                    }
                } else {
                    pendingRewards[ref] += reward;
                    totalPendingRewards += reward;
                }

                totalEarned[ref] += reward;
                emit ReferralRewardDistributed(ref, reward, i);
            }

            ref = referrals[ref];
            unchecked { ++i; }
        }
    }

    /// @dev Initializes a cloned token, records metadata, and emits TokenCreated.
    function _initAndRecord(
        CreateTokenParams calldata p,
        address creator,
        address mintTo,
        address tokenAddress,
        uint256 fee,
        address referrer,
        uint8 typeKey
    ) internal {
        uint256 supply = p.totalSupply * 10 ** p.decimals;

        address[] memory bases = _sanitizeBases(p.bases, tokenAddress, p.isPartner);
        IToken(tokenAddress).initialize(
            p.name, p.symbol, supply, p.decimals, mintTo, address(this),
            dexRouter.factory(), bases
        );

        createdTokens[creator].push(tokenAddress);
        _allTokens.push(tokenAddress);
        tokenInfo[tokenAddress] = TokenInfo({
            creator: creator,
            isMintable: p.isMintable,
            isTaxable: p.isTaxable,
            isPartnership: p.isPartner
        });

        totalTokensCreated++;
        tokensCreatedByType[typeKey]++;

        emit TokenCreated(
            creator, tokenAddress, typeKey,
            p.name, p.symbol, p.totalSupply, p.decimals,
            fee, referrer
        );
    }

    /// @dev Generates a deterministic salt from the creator address and their nonce.
    function _computeSalt(address creator) internal returns (bytes32) {
        uint256 nonce = creatorNonce[creator]++;
        return keccak256(abi.encodePacked(creator, nonce));
    }

    /// @dev Records daily stats. `feeUsdt` is the actual USDT amount collected.
    function _recordStats(uint8 typeKey, uint256 feeUsdt) internal {
        uint256 day = block.timestamp / 1 days;
        DayStats storage ds = dailyStats[day];

        if (typeKey == 0) ds.basic++;
        else if (typeKey == 1) ds.mintable++;
        else if (typeKey == 2) ds.taxable++;
        else if (typeKey == 3) ds.taxMintable++;
        else if (typeKey == 4) ds.partner++;
        else if (typeKey == 5) ds.partnerMint++;
        else if (typeKey == 6) ds.partnerTax++;
        else if (typeKey == 7) ds.partnerTaxMint++;

        ds.totalTokens++;
        ds.totalFeeUsdt += feeUsdt;
        totalFeeEarnedUsdt += feeUsdt;
    }

    // =============================================================
    // TOKEN CREATION
    // =============================================================

    /// @notice Creates a new token. Caller must have approved this contract
    ///         for `creationFee[typeKey]` USDT before calling.
    function createToken(CreateTokenParams calldata p, address referral)
        external nonReentrant returns (address tokenAddress)
    {
        if (p.totalSupply == 0 || p.totalSupply > 1e30 || p.decimals > 18
            || bytes(p.name).length == 0 || bytes(p.symbol).length == 0)
            revert InvalidParams();

        uint8 typeKey = _tokenTypeKey(p.isTaxable, p.isMintable, p.isPartner);
        address impl = implementations[typeKey];
        if (impl == address(0)) revert ImplementationNotSet();

        uint256 fee = creationFee[typeKey];
        _collectFee(fee);
        _processReferral(msg.sender, referral, fee);
        _reportAffiliate(msg.sender, referral, fee);
        _recordStats(typeKey, fee);

        bytes32 salt = _computeSalt(msg.sender);
        tokenAddress = Clones.cloneDeterministic(impl, salt);
        _initAndRecord(p, msg.sender, msg.sender, tokenAddress, fee, referral, typeKey);
    }

    /// @notice Creates a token on behalf of `creator`. Owner only.
    ///         Owner pays the USDT fee from their own balance.
    function ownerCreateToken(address creator, CreateTokenParams calldata p, address referral)
        external onlyOwner nonReentrant returns (address tokenAddress)
    {
        if (creator == address(0)) revert InvalidAddress();
        if (p.totalSupply == 0 || p.totalSupply > 1e30 || p.decimals > 18
            || bytes(p.name).length == 0 || bytes(p.symbol).length == 0)
            revert InvalidParams();

        uint8 typeKey = _tokenTypeKey(p.isTaxable, p.isMintable, p.isPartner);
        address impl = implementations[typeKey];
        if (impl == address(0)) revert ImplementationNotSet();

        uint256 fee = creationFee[typeKey];
        _collectFee(fee);
        _processReferral(creator, referral, fee);
        _reportAffiliate(creator, referral, fee);
        _recordStats(typeKey, fee);

        bytes32 salt = _computeSalt(creator);
        tokenAddress = Clones.cloneDeterministic(impl, salt);
        _initAndRecord(p, creator, creator, tokenAddress, fee, referral, typeKey);
    }

    /// @notice Creates a token on behalf of a user via the authorized PlatformRouter.
    /// @dev    Tokens are minted to address(this) so the router can distribute them
    ///         (e.g., to a launch instance). The router has already swapped the user's
    ///         input token to USDT and approved this contract for the exact fee.
    function routerCreateToken(address creator, CreateTokenParams calldata p, address referral)
        external nonReentrant returns (address tokenAddress)
    {
        if (authorizedRouter == address(0) || msg.sender != authorizedRouter) revert NotAuthorizedRouter();
        if (creator == address(0)) revert InvalidAddress();
        if (p.totalSupply == 0 || p.totalSupply > 1e30 || p.decimals > 18
            || bytes(p.name).length == 0 || bytes(p.symbol).length == 0)
            revert InvalidParams();

        uint8 typeKey = _tokenTypeKey(p.isTaxable, p.isMintable, p.isPartner);
        address impl = implementations[typeKey];
        if (impl == address(0)) revert ImplementationNotSet();

        uint256 fee = creationFee[typeKey];
        _collectFee(fee);
        _processReferral(creator, referral, fee);
        _reportAffiliate(creator, referral, fee);
        _recordStats(typeKey, fee);

        bytes32 salt = _computeSalt(creator);
        tokenAddress = Clones.cloneDeterministic(impl, salt);

        // Mint to factory so the router can pull the supply afterward.
        _initAndRecord(p, creator, address(this), tokenAddress, fee, referral, typeKey);

        uint256 tokenBalance = IERC20(tokenAddress).balanceOf(address(this));
        IERC20(tokenAddress).safeTransfer(msg.sender, tokenBalance);

        // Hand ownership to the router so it can configure protections,
        // enable trading, and ultimately transfer ownership to the creator.
        IOwnableToken(tokenAddress).transferOwnership(msg.sender);
    }

    // =============================================================
    // TAX PROCESSING
    // =============================================================

    /// @notice Token-side callback. Emits a signal that tax has
    ///         accumulated on this factory for `token`; the actual
    ///         token→USDT swap is done off-chain by an admin-side
    ///         daemon via `processTaxAuth` so the slippage parameter
    ///         comes from a private price feed instead of an in-tx
    ///         `getAmountsOut` call (which a flash-loan attacker could
    ///         manipulate to drain the tax balance through sandwich).
    ///
    ///         Only registered TokenKrafter tokens can emit. External
    ///         tokens that happen to call into this address are
    ///         silently ignored — emitting for them would pollute the
    ///         daemon's signal feed.
    function processTax(address token) external {
        if (msg.sender != token) return;
        if (tokenInfo[token].creator == address(0)) return;
        if (token == usdt) return;
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;
        emit TaxAccumulated(token, balance);
    }

    /// @notice Daemon-driven tax conversion. The off-chain admin
    ///         monitors `TaxAccumulated` events, computes the safe
    ///         swap path + `amountOutMin` from a private quote, and
    ///         submits this tx. `path` must start at `token` and end
    ///         at `usdt`; `amountOutMin` is enforced by the DEX router
    ///         and bounds slippage to whatever the daemon decided was
    ///         acceptable.
    function processTaxAuth(
        address token,
        address[] calldata path,
        uint256 amountOutMin
    ) external onlyOwner nonReentrant {
        if (token == usdt) return;
        if (path.length < 2 || path[0] != token || path[path.length - 1] != usdt) revert InvalidPath();

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;

        IERC20(token).forceApprove(address(dexRouter), balance);
        try dexRouter.swapExactTokensForTokens(
            balance,
            amountOutMin,
            path,
            address(this),
            block.timestamp
        ) returns (uint256[] memory amounts) {
            emit TaxProcessed(token, balance, amounts[amounts.length - 1]);
        } catch {
            emit TaxProcessFailed(token, balance);
        }
    }

    // =============================================================
    // REFERRAL CLAIMS
    // =============================================================

    /// @notice Claims accumulated USDT referral rewards.
    function claimReward() external nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        if (amount == 0) revert NoRewards();

        pendingRewards[msg.sender] = 0;
        totalPendingRewards -= amount;

        IERC20(usdt).safeTransfer(msg.sender, amount);

        emit ReferralRewardClaimed(msg.sender, amount);
    }

    // =============================================================
    // VIEW FUNCTIONS
    // =============================================================

    function getCreatedTokens(address creator) external view returns (address[] memory) {
        return createdTokens[creator];
    }

    function getTokenByIndex(uint256 index) external view returns (address) {
        return _allTokens[index];
    }

    function getTokens(uint256 offset, uint256 limit) external view returns (address[] memory tokens, uint256 total) {
        total = _allTokens.length;
        if (offset >= total) return (new address[](0), total);
        uint256 end = offset + limit;
        if (end > total) end = total;
        tokens = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            tokens[i - offset] = _allTokens[i];
        }
    }

    function getTokensInfo(uint256 offset, uint256 limit) external view returns (TokenView[] memory views, uint256 total) {
        total = _allTokens.length;
        if (offset >= total) return (new TokenView[](0), total);
        uint256 end = offset + limit;
        if (end > total) end = total;
        views = new TokenView[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            views[i - offset] = _buildTokenView(_allTokens[i]);
        }
    }

    function _buildTokenView(address token) internal view returns (TokenView memory v) {
        v.tokenAddress = token;
        TokenInfo memory info = tokenInfo[token];
        v.creator = info.creator;
        v.isMintable = info.isMintable;
        v.isTaxable = info.isTaxable;
        v.isPartnership = info.isPartnership;

        try ERC20(token).name() returns (string memory n) { v.name = n; } catch {}
        try ERC20(token).symbol() returns (string memory s) { v.symbol = s; } catch {}
        try ERC20(token).decimals() returns (uint8 d) { v.decimals = d; } catch {}
        try ERC20(token).totalSupply() returns (uint256 ts) { v.totalSupply = ts; } catch {}
    }

    /// @notice Returns key factory state in a single call for dashboards.
    function getState() external view returns (
        address factoryOwner,
        uint256 totalTokens,
        uint256 totalFeeUsdt,
        uint256[8] memory feesPerType,
        uint256[8] memory countPerType,
        bool taxToStable,
        uint256 taxSlippage,
        uint8 refLevels,
        bool autoDistribute
    ) {
        factoryOwner = owner();
        totalTokens = totalTokensCreated;
        totalFeeUsdt = totalFeeEarnedUsdt;
        for (uint8 i = 0; i < 8; i++) {
            feesPerType[i] = creationFee[i];
            countPerType[i] = tokensCreatedByType[i];
        }
        // Tax-to-stable is always-on now (event-driven, daemon does
        // the swap). Slot kept in the tuple for ABI continuity with
        // the lens contracts that destructure this return.
        taxToStable = true;
        taxSlippage = taxSlippageBps;
        refLevels = referralLevels;
        autoDistribute = autoDistributeReward;
    }

    /// @notice Aggregated USDT referral stats for a referrer.
    function getReferralStats(address referrer) external view returns (
        uint256 referred,
        uint256 earned,
        uint256 pending
    ) {
        referred = totalReferred[referrer];
        earned = totalEarned[referrer];
        pending = pendingRewards[referrer];
    }

    function getReferralChain(address user) external view returns (address[] memory chain) {
        address[] memory temp = new address[](referralLevels);
        uint256 length = 0;
        address current = user;
        for (uint8 i = 0; i < referralLevels; i++) {
            address referrer = referrals[current];
            if (referrer == address(0)) break;
            temp[length++] = referrer;
            current = referrer;
        }
        chain = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            chain[i] = temp[i];
        }
    }

    function getReferralPercents() external view returns (uint256[] memory percents) {
        percents = new uint256[](referralLevels);
        for (uint256 i = 0; i < referralLevels; i++) {
            percents[i] = referralPercents[i];
        }
    }

    /// @notice Returns USDT-denominated creation + launchpad fees for the
    ///         given token type. Single-token API since everything is USDT.
    function getCreationFees(
        bool isTaxable,
        bool isMintable,
        bool isPartner,
        address launchpadFactory
    ) external view returns (uint256 creationFeeUsdt, uint256 launchFeeUsdt) {
        uint8 typeKey = _tokenTypeKey(isTaxable, isMintable, isPartner);
        creationFeeUsdt = creationFee[typeKey];
        if (launchpadFactory != address(0)) {
            try ILaunchpadFee(launchpadFactory).launchFee() returns (uint256 f) {
                launchFeeUsdt = f;
            } catch {}
        }
    }

    function predictTokenAddress(
        address creator,
        bool isTaxable,
        bool isMintable,
        bool isPartner
    ) external view returns (address predicted) {
        uint8 typeKey = _tokenTypeKey(isTaxable, isMintable, isPartner);
        address impl = implementations[typeKey];
        if (impl == address(0)) revert ImplementationNotSet();

        bytes32 salt = keccak256(abi.encodePacked(creator, creatorNonce[creator]));
        predicted = Clones.predictDeterministicAddress(impl, salt, address(this));
    }

    // =============================================================
    // ADMIN
    // =============================================================

    function setImplementation(uint8 tokenType, address impl) external onlyOwner {
        if (tokenType > 7) revert InvalidTokenType();
        if (impl == address(0)) revert InvalidAddress();
        implementations[tokenType] = impl;
        emit ImplementationUpdated(tokenType, impl);
    }

    function setCreationFee(uint8 tokenType, uint256 fee) external onlyOwner {
        if (tokenType > 7) revert InvalidTokenType();
        creationFee[tokenType] = fee;
    }

    /// @notice Set every implementation address and its creation fee in one
    ///         transaction. Pass address(0) for an `impls[i]` slot to skip.
    function setImplementationsAndFees(
        address[8] calldata impls,
        uint256[8] calldata fees
    ) external onlyOwner {
        for (uint8 i = 0; i < 8; i++) {
            if (impls[i] == address(0)) continue;
            implementations[i] = impls[i];
            creationFee[i] = fees[i];
            emit ImplementationUpdated(i, impls[i]);
        }
    }


    function setTaxSlippage(uint256 _bps) external onlyOwner {
        if (_bps > 5000) revert TotalExceedsMax();
        taxSlippageBps = _bps;
    }

    function setDexRouter(address _dexRouter) external onlyOwner {
        if (_dexRouter == address(0)) revert InvalidAddress();
        dexRouter = IUniswapV2Router02(_dexRouter);
    }

    function setUsdt(address _usdt) external onlyOwner {
        if (_usdt == address(0)) revert InvalidAddress();
        usdt = _usdt;
    }

    function setReferralLevels(uint8 _levels) external onlyOwner {
        if (_levels > 10) revert MaxLevelsExceeded();
        referralLevels = _levels;
    }

    function setReferralPercents(uint256[] calldata _percents) external onlyOwner {
        uint256 total;
        for (uint256 i; i < _percents.length;) {
            total += _percents[i];
            unchecked { ++i; }
        }
        if (total > 5000) revert TotalExceedsMax();

        delete referralPercents;
        for (uint256 i; i < _percents.length;) {
            referralPercents.push(_percents[i]);
            unchecked { ++i; }
        }
    }

    function setAutoDistributeReward(bool _enabled) external onlyOwner {
        autoDistributeReward = _enabled;
    }

    /// @notice Withdraws accumulated balance of an arbitrary token. For USDT,
    ///         the reserved referral rewards are excluded from withdrawable amount.
    function withdrawFees(address token) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 reserved = token == usdt ? totalPendingRewards : 0;
        uint256 withdrawable = bal > reserved ? bal - reserved : 0;
        if (withdrawable == 0) revert NoBalance();
        IERC20(token).safeTransfer(platformWallet, withdrawable);
    }

    function setAuthorizedRouter(address _router) external onlyOwner {
        authorizedRouter = _router;
    }

    function setPlatformWallet(address wallet) external onlyOwner {
        if (wallet == address(0)) revert InvalidAddress();
        emit PlatformWalletUpdated(platformWallet, wallet);
        platformWallet = wallet;
    }

    // =============================================================
    // PARTNER DEFAULT BASES — admin
    // =============================================================

    event DefaultPartnerBaseAdded(address indexed base);
    event DefaultPartnerBaseRemoved(address indexed base);

    /// @notice Adds a base token to the partner-default list. Future partner
    ///         tokens will have this base force-merged into their `bases[]`.
    function addDefaultPartnerBase(address base) external onlyOwner {
        if (base == address(0)) revert InvalidAddress();
        if (isDefaultPartnerBase[base]) return;
        if (_defaultPartnerBases.length >= MAX_DEFAULT_PARTNER_BASES) revert InvalidParams();
        isDefaultPartnerBase[base] = true;
        _defaultPartnerBases.push(base);
        emit DefaultPartnerBaseAdded(base);
    }

    /// @notice Removes a base from the partner-default list. Existing tokens
    ///         are unaffected — only future creations stop force-merging it.
    function removeDefaultPartnerBase(address base) external onlyOwner {
        if (!isDefaultPartnerBase[base]) return;
        isDefaultPartnerBase[base] = false;
        uint256 len = _defaultPartnerBases.length;
        for (uint256 i; i < len;) {
            if (_defaultPartnerBases[i] == base) {
                _defaultPartnerBases[i] = _defaultPartnerBases[len - 1];
                _defaultPartnerBases.pop();
                break;
            }
            unchecked { ++i; }
        }
        emit DefaultPartnerBaseRemoved(base);
    }

    function getDefaultPartnerBases() external view returns (address[] memory) {
        return _defaultPartnerBases;
    }

    /// @notice Replace the entire partner-default base list in one call.
    ///         Clears the existing list and installs `bases` as the new set.
    ///         Duplicates and zero addresses are rejected. Existing tokens
    ///         are unaffected — only future partner-variant creations see
    ///         the new list.
    function setDefaultPartnerBases(address[] calldata bases) external onlyOwner {
        if (bases.length > MAX_DEFAULT_PARTNER_BASES) revert InvalidParams();
        uint256 oldLen = _defaultPartnerBases.length;
        for (uint256 i; i < oldLen;) {
            address b = _defaultPartnerBases[i];
            isDefaultPartnerBase[b] = false;
            emit DefaultPartnerBaseRemoved(b);
            unchecked { ++i; }
        }
        delete _defaultPartnerBases;

        uint256 newLen = bases.length;
        for (uint256 i; i < newLen;) {
            address b = bases[i];
            if (b == address(0)) revert InvalidAddress();
            if (isDefaultPartnerBase[b]) revert InvalidParams(); // duplicate
            isDefaultPartnerBase[b] = true;
            _defaultPartnerBases.push(b);
            emit DefaultPartnerBaseAdded(b);
            unchecked { ++i; }
        }
    }

    // =============================================================
    // PROTECTION OVERRIDES (owner can relax token protections)
    // =============================================================

    function forceUnblacklist(address token, address account) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        BasicTokenImpl(token).forceUnblacklist(account);
    }

    function forceRelaxMaxWallet(address token, uint256 amount) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        BasicTokenImpl(token).forceRelaxMaxWallet(amount);
    }

    function forceRelaxMaxTransaction(address token, uint256 amount) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        BasicTokenImpl(token).forceRelaxMaxTransaction(amount);
    }

    function forceRelaxCooldown(address token, uint256 _seconds) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        BasicTokenImpl(token).forceRelaxCooldown(_seconds);
    }

    function forceDisableBlacklist(address token) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        BasicTokenImpl(token).forceDisableBlacklist();
    }

    /// @notice Force-reduce a taxable token's tax rates AND ceilings.
    ///         Each new value must be ≤ the current value — the factory can
    ///         only lower, never raise. The ceiling is tightened in lock-step
    ///         so the creator can never undo the platform's reduction.
    function forceRelaxTaxes(
        address token,
        uint256 newBuyBps,
        uint256 newSellBps,
        uint256 newTransferBps
    ) external onlyOwner {
        if (tokenInfo[token].creator == address(0)) revert NotFactoryToken();
        TaxableTokenImpl(token).forceRelaxTaxes(newBuyBps, newSellBps, newTransferBps);
    }
}

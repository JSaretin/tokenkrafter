// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";


// =============================================================
// DEX INTERFACES
// =============================================================

interface IUniswapV2Router02 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external view returns (uint256[] memory amounts);
}

interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

// =============================================================
// TOKEN INTERFACES
// =============================================================

interface IToken {
    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 decimals,
        address creator
    ) external;
}

interface IPartnerToken {
    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 decimals,
        address creator,
        address factory
    ) external;

    function setupPools(address[] calldata pools) external;
}

// =============================================================
// BASE IMPLEMENTATION
// =============================================================

contract BasicTokenImpl is ERC20Upgradeable, OwnableUpgradeable {
    constructor() {
        _disableInitializers();
    }

    uint8 private decimals_;
    mapping(address => bool) public isPool;

    event PoolUpdated(address indexed pool, bool added);

    function _baseInit(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator
    ) internal {
        require(_decimals <= 18);
        __ERC20_init(name, symbol);
        decimals_ = _decimals;
        __Ownable_init(creator);
        _mint(creator, totalSupply);
    }

    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator
    ) public virtual initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator);
    }

    function decimals() public view override returns (uint8) {
        return decimals_;
    }

    function addPool(address pool) external onlyOwner {
        require(pool != address(0), "Invalid pool");
        isPool[pool] = true;
        emit PoolUpdated(pool, true);
    }

    function removePool(address pool) external onlyOwner {
        isPool[pool] = false;
        emit PoolUpdated(pool, false);
    }
}

// =============================================================
// MINTABLE IMPLEMENTATION
// =============================================================

contract MintableTokenImpl is BasicTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

// =============================================================
// TAXABLE IMPLEMENTATION
// =============================================================

contract TaxableTokenImpl is BasicTokenImpl {
    uint256 public buyTaxBps;
    uint256 public sellTaxBps;
    uint256 public transferTaxBps;

    address[] public taxWallets;
    uint16[] public taxSharesBps;

    mapping(address => bool) public isTaxFree;

    event TaxDistributionUpdated(uint256 totalShareBps);
    event TaxExemptUpdated(address indexed account, bool exempt);

    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator
    ) public override initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator);
    }

    function setTaxDistribution(
        address[] calldata wallets,
        uint16[] calldata sharesBps
    ) external onlyOwner {
        require(wallets.length == sharesBps.length, "Length mismatch");
        require(wallets.length <= 10, "Max 10 wallets");

        for (uint256 i = 0; i < taxWallets.length; i++) {
            isTaxFree[taxWallets[i]] = false;
        }

        delete taxWallets;
        delete taxSharesBps;

        uint256 sum = 0;
        for (uint256 i = 0; i < sharesBps.length; i++) {
            require(sharesBps[i] > 0, "Share > 0");
            sum += sharesBps[i];
        }
        require(sum <= 10000, "Total share > 100%");

        for (uint256 i = 0; i < wallets.length; i++) {
            require(wallets[i] != address(0), "Zero address");
            taxWallets.push(wallets[i]);
            taxSharesBps.push(sharesBps[i]);
            isTaxFree[wallets[i]] = true;
        }

        emit TaxDistributionUpdated(sum);
    }

    function setTaxes(
        uint256 _buyTaxBps,
        uint256 _sellTaxBps,
        uint256 _transferTaxBps
    ) external onlyOwner {
        require(_buyTaxBps + _sellTaxBps + _transferTaxBps <= 2500, "Total tax <= 25%");
        buyTaxBps = _buyTaxBps;
        sellTaxBps = _sellTaxBps;
        transferTaxBps = _transferTaxBps;
    }

    function excludeFromTax(address account, bool exempt) external onlyOwner {
        isTaxFree[account] = exempt;
        emit TaxExemptUpdated(account, exempt);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0) || value == 0) {
            super._update(from, to, value);
            return;
        }

        if (isTaxFree[from] || isTaxFree[to]) {
            super._update(from, to, value);
            return;
        }

        uint256 tax = 0;
        if (!isPool[from] && !isPool[to]) {
            tax = (value * transferTaxBps) / 10000;
        } else if (isPool[from]) {
            tax = (value * buyTaxBps) / 10000;
        } else if (isPool[to]) {
            tax = (value * sellTaxBps) / 10000;
        }

        if (tax == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 remaining = tax;
        uint256 len = taxWallets.length;

        for (uint256 i = 0; i < len; i++) {
            uint256 amount = (tax * taxSharesBps[i]) / 10000;
            if (amount > 0) {
                super._update(from, taxWallets[i], amount);
                remaining -= amount;
            }
        }

        if (remaining > 0) {
            super._update(from, address(0), remaining);
        }

        super._update(from, to, value - tax);
    }
}

// =============================================================
// TAXABLE + MINTABLE
// =============================================================

contract TaxableMintableTokenImpl is TaxableTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

// =============================================================
// PARTNER IMPLEMENTATION (1% factory tax on buys/sells)
// =============================================================

contract PartnerTokenImpl is BasicTokenImpl {
    address public factory;
    bool private _poolsInitialized;
    uint16 public constant PARTNERSHIP_BPS = 100; // 1%

    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator,
        address _factory
    ) public virtual initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator);
        factory = _factory;
    }

    function setupPools(address[] calldata pools) external {
        require(msg.sender == factory, "Only factory");
        require(!_poolsInitialized, "Already initialized");
        _poolsInitialized = true;
        for (uint256 i = 0; i < pools.length; i++) {
            if (pools[i] != address(0)) {
                isPool[pools[i]] = true;
                emit PoolUpdated(pools[i], true);
            }
        }
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from != address(0) && to != address(0) && value > 0
            && from != factory && to != factory
            && (isPool[from] || isPool[to]))
        {
            uint256 pTax = (value * PARTNERSHIP_BPS) / 10000;
            if (pTax > 0) {
                super._update(from, factory, pTax);
                super._update(from, to, value - pTax);
                return;
            }
        }
        super._update(from, to, value);
    }
}

// =============================================================
// PARTNER + MINTABLE
// =============================================================

contract PartnerMintableTokenImpl is PartnerTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

// =============================================================
// PARTNER + TAXABLE
// =============================================================

contract PartnerTaxableTokenImpl is TaxableTokenImpl {
    address public factory;
    bool private _poolsInitialized;
    uint16 public constant PARTNERSHIP_BPS = 100; // 1%

    function initialize(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        uint8 _decimals,
        address creator,
        address _factory
    ) public virtual initializer {
        _baseInit(name, symbol, totalSupply, _decimals, creator);
        factory = _factory;
    }

    function setupPools(address[] calldata pools) external {
        require(msg.sender == factory, "Only factory");
        require(!_poolsInitialized, "Already initialized");
        _poolsInitialized = true;
        for (uint256 i = 0; i < pools.length; i++) {
            if (pools[i] != address(0)) {
                isPool[pools[i]] = true;
                emit PoolUpdated(pools[i], true);
            }
        }
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        // Mint/burn pass through
        if (from == address(0) || to == address(0) || value == 0) {
            ERC20Upgradeable._update(from, to, value);
            return;
        }

        // Factory always exempt from all taxes
        if (from == factory || to == factory) {
            ERC20Upgradeable._update(from, to, value);
            return;
        }

        bool isBuy = isPool[from];
        bool isSell = isPool[to];
        uint256 totalDeducted = 0;

        // Partnership tax (buys/sells only)
        if (isBuy || isSell) {
            uint256 pTax = (value * PARTNERSHIP_BPS) / 10000;
            if (pTax > 0) {
                ERC20Upgradeable._update(from, factory, pTax);
                totalDeducted += pTax;
            }
        }

        // User tax (skip if either side is tax-free)
        if (!isTaxFree[from] && !isTaxFree[to]) {
            uint256 taxBps;
            if (isBuy) taxBps = buyTaxBps;
            else if (isSell) taxBps = sellTaxBps;
            else taxBps = transferTaxBps;

            uint256 userTax = (value * taxBps) / 10000;
            if (userTax > 0) {
                uint256 remaining = userTax;
                uint256 len = taxWallets.length;

                for (uint256 i = 0; i < len; i++) {
                    uint256 amt = (userTax * taxSharesBps[i]) / 10000;
                    if (amt > 0) {
                        ERC20Upgradeable._update(from, taxWallets[i], amt);
                        remaining -= amt;
                    }
                }

                if (remaining > 0) {
                    ERC20Upgradeable._update(from, address(0), remaining);
                }
                totalDeducted += userTax;
            }
        }

        ERC20Upgradeable._update(from, to, value - totalDeducted);
    }
}

// =============================================================
// PARTNER + TAXABLE + MINTABLE
// =============================================================

contract PartnerTaxableMintableTokenImpl is PartnerTaxableTokenImpl {
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

// =============================================================
// TOKEN FACTORY
// =============================================================

contract TokenFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct TokenInfo {
        address creator;
        bool isMintable;
        bool isTaxable;
        bool isPartnership;
    }

    struct CreateTokenParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint8 decimals;
        bool isTaxable;
        bool isMintable;
        bool isPartner;
        address paymentToken;
    }

    // Token type keys (bitfield: partner=4, taxable=2, mintable=1)
    // 0=basic, 1=mintable, 2=taxable, 3=taxable+mintable,
    // 4=partner, 5=partner+mintable, 6=partner+taxable, 7=partner+taxable+mintable

    IUniswapV2Router02 public dexRouter;
    address public usdt; // fee denomination token

    // Implementation address per token type key
    mapping(uint8 => address) public implementations;

    // Creation fees in USDT per token type key
    mapping(uint8 => uint256) public creationFee;

    // Dynamic supported payment tokens (address(0) = native BNB/ETH)
    address[] private _supportedTokens;
    mapping(address => bool) public isPaymentSupported;

    mapping(address => address[]) private createdTokens;
    mapping(address => TokenInfo) public tokenInfo;

    event TokenCreated(
        address indexed creator,
        address indexed tokenAddress,
        uint8 tokenType,
        string name,
        string symbol,
        uint256 totalSupply,
        uint8 decimals
    );
    event ImplementationUpdated(uint8 indexed tokenType, address impl);
    event PaymentTokenAdded(address indexed token);
    event PaymentTokenRemoved(address indexed token);

    constructor(
        address _usdt,
        address _dexRouter
    ) Ownable(msg.sender) {
        require(_usdt != address(0), "Invalid USDT");
        require(_dexRouter != address(0), "Invalid router");

        usdt = _usdt;
        dexRouter = IUniswapV2Router02(_dexRouter);

        uint8 _usdtDecimals = ERC20(_usdt).decimals();

        // Default fees in USDT
        creationFee[0] = 10 * 10 ** _usdtDecimals;  // basic
        creationFee[1] = 20 * 10 ** _usdtDecimals;  // mintable
        creationFee[2] = 25 * 10 ** _usdtDecimals;  // taxable
        creationFee[3] = 35 * 10 ** _usdtDecimals;  // taxable+mintable
        creationFee[4] = 15 * 10 ** _usdtDecimals;  // partner
        creationFee[5] = 25 * 10 ** _usdtDecimals;  // partner+mintable
        creationFee[6] = 30 * 10 ** _usdtDecimals;  // partner+taxable
        creationFee[7] = 40 * 10 ** _usdtDecimals;  // partner+taxable+mintable

        // Auto-add USDT and native as supported payment
        _addPaymentToken(_usdt);
        _addPaymentToken(address(0));
    }

    // =============================================================
    // INTERNAL HELPERS
    // =============================================================

    function _tokenTypeKey(bool isTaxable, bool isMintable, bool isPartner)
        internal pure returns (uint8)
    {
        return uint8((isPartner ? 4 : 0) | (isTaxable ? 2 : 0) | (isMintable ? 1 : 0));
    }

    function _convertFee(uint256 usdtAmount, address paymentToken)
        internal view returns (uint256)
    {
        if (usdtAmount == 0) return 0;
        if (paymentToken == usdt) return usdtAmount;

        address tokenIn = paymentToken == address(0)
            ? dexRouter.WETH()
            : paymentToken;

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = usdt;

        try dexRouter.getAmountsIn(usdtAmount, path) returns (uint256[] memory amounts) {
            return amounts[0];
        } catch {
            return 0;
        }
    }

    function _collectFeeFrom(
        address payer,
        address paymentToken,
        uint8 typeKey
    ) internal {
        uint256 baseFee = creationFee[typeKey];
        if (baseFee == 0) return;

        require(isPaymentSupported[paymentToken], "Unsupported payment token");

        uint256 amount = _convertFee(baseFee, paymentToken);
        require(amount > 0, "Cannot determine fee");

        if (paymentToken == address(0)) {
            require(msg.value >= amount, "Insufficient native payment");
            uint256 excess = msg.value - amount;
            if (excess > 0) {
                (bool ok, ) = msg.sender.call{value: excess}("");
                require(ok, "Refund failed");
            }
        } else {
            IERC20(paymentToken).safeTransferFrom(payer, address(this), amount);
        }
    }

    function _setupPartnerPools(address token) internal {
        IUniswapV2Factory dexFactory = IUniswapV2Factory(dexRouter.factory());
        address weth = dexRouter.WETH();
        uint256 len = _supportedTokens.length;
        address[] memory pools = new address[](len);
        uint256 count = 0;

        for (uint256 i = 0; i < len; i++) {
            address quoteToken = _supportedTokens[i] == address(0)
                ? weth
                : _supportedTokens[i];

            // Skip if quote token is the token itself
            if (quoteToken == token) continue;

            address pair = dexFactory.getPair(token, quoteToken);
            if (pair == address(0)) {
                pair = dexFactory.createPair(token, quoteToken);
            }
            pools[count] = pair;
            count++;
        }

        // Trim array to actual count
        assembly ("memory-safe") { mstore(pools, count) }

        IPartnerToken(token).setupPools(pools);
    }

    function _addPaymentToken(address token) internal {
        if (!isPaymentSupported[token]) {
            isPaymentSupported[token] = true;
            _supportedTokens.push(token);
            emit PaymentTokenAdded(token);
        }
    }

    function _initAndRecord(
        CreateTokenParams calldata p,
        address creator,
        address tokenAddress,
        uint8 typeKey
    ) internal {
        uint256 supply = p.totalSupply * 10 ** p.decimals;

        if (p.isPartner) {
            IPartnerToken(tokenAddress).initialize(
                p.name, p.symbol, supply, p.decimals, creator, address(this)
            );
            _setupPartnerPools(tokenAddress);
        } else {
            IToken(tokenAddress).initialize(
                p.name, p.symbol, supply, p.decimals, creator
            );
        }

        createdTokens[creator].push(tokenAddress);
        tokenInfo[tokenAddress] = TokenInfo({
            creator: creator,
            isMintable: p.isMintable,
            isTaxable: p.isTaxable,
            isPartnership: p.isPartner
        });

        emit TokenCreated(
            creator, tokenAddress, typeKey,
            p.name, p.symbol, p.totalSupply, p.decimals
        );
    }

    // =============================================================
    // TOKEN CREATION
    // =============================================================

    function createToken(CreateTokenParams calldata p)
        external payable nonReentrant returns (address tokenAddress)
    {
        require(p.totalSupply > 0 && p.decimals <= 18
            && bytes(p.name).length > 0 && bytes(p.symbol).length > 0);

        uint8 typeKey = _tokenTypeKey(p.isTaxable, p.isMintable, p.isPartner);
        address impl = implementations[typeKey];
        require(impl != address(0), "Token type not supported");

        _collectFeeFrom(msg.sender, p.paymentToken, typeKey);

        tokenAddress = Clones.clone(impl);
        _initAndRecord(p, msg.sender, tokenAddress, typeKey);

        return tokenAddress;
    }

    function ownerCreateToken(address creator, CreateTokenParams calldata p)
        external payable onlyOwner nonReentrant returns (address tokenAddress)
    {
        require(creator != address(0), "Invalid creator");
        require(p.totalSupply > 0 && p.decimals <= 18
            && bytes(p.name).length > 0 && bytes(p.symbol).length > 0);

        uint8 typeKey = _tokenTypeKey(p.isTaxable, p.isMintable, p.isPartner);
        address impl = implementations[typeKey];
        require(impl != address(0), "Token type not supported");

        _collectFeeFrom(creator, p.paymentToken, typeKey);

        tokenAddress = Clones.clone(impl);
        _initAndRecord(p, creator, tokenAddress, typeKey);

        return tokenAddress;
    }

    // =============================================================
    // VIEW FUNCTIONS
    // =============================================================

    function getCreatedTokens(address creator) external view returns (address[] memory) {
        return createdTokens[creator];
    }

    function getTokenInfo(address token) external view returns (TokenInfo memory) {
        return tokenInfo[token];
    }

    function getCreationFee(bool isTaxable, bool isMintable, bool isPartner)
        external view returns (address[] memory tokens, uint256[] memory fees)
    {
        uint8 typeKey = _tokenTypeKey(isTaxable, isMintable, isPartner);
        uint256 baseFee = creationFee[typeKey];
        uint256 len = _supportedTokens.length;

        tokens = new address[](len);
        fees = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            tokens[i] = _supportedTokens[i];
            fees[i] = _convertFee(baseFee, _supportedTokens[i]);
        }
    }

    function getSupportedPaymentTokens() external view returns (address[] memory) {
        return _supportedTokens;
    }

    // =============================================================
    // ADMIN FUNCTIONS
    // =============================================================

    function setImplementation(uint8 tokenType, address impl) external onlyOwner {
        require(tokenType <= 7, "Invalid token type");
        require(impl != address(0), "Invalid implementation");
        implementations[tokenType] = impl;
        emit ImplementationUpdated(tokenType, impl);
    }

    function setCreationFee(uint8 tokenType, uint256 fee) external onlyOwner {
        require(tokenType <= 7, "Invalid token type");
        creationFee[tokenType] = fee;
    }

    function setDexRouter(address _dexRouter) external onlyOwner {
        require(_dexRouter != address(0), "Invalid router");
        dexRouter = IUniswapV2Router02(_dexRouter);
    }

    function addPaymentToken(address token) external onlyOwner {
        require(!isPaymentSupported[token], "Already supported");
        _addPaymentToken(token);
    }

    function removePaymentToken(address token) external onlyOwner {
        require(isPaymentSupported[token], "Not supported");
        isPaymentSupported[token] = false;

        uint256 len = _supportedTokens.length;
        for (uint256 i = 0; i < len; i++) {
            if (_supportedTokens[i] == token) {
                _supportedTokens[i] = _supportedTokens[len - 1];
                _supportedTokens.pop();
                break;
            }
        }
        emit PaymentTokenRemoved(token);
    }

    function withdrawToken(address token) external onlyOwner {
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            require(bal > 0, "No balance");
            (bool ok, ) = msg.sender.call{value: bal}("");
            require(ok, "Transfer failed");
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            require(bal > 0, "No balance");
            IERC20(token).safeTransfer(msg.sender, bal);
        }
    }

    receive() external payable {}
}

import { Address, BigDecimal, BigInt, log } from '@graphprotocol/graph-ts';
import { Token, Vault } from '../../../generated/schema';
import {
  AERODROME_SWAP_FACTORY_BASE,
  BASE_SWAP_FACTORY_BASE,
  BD_18,
  BD_ONE,
  BD_TEN,
  BD_ZERO,
  BI_18,
  BI_TEN,
  BSX_BASE,
  CB_ETH_ETH_POOL_BASE,
  checkBalancer,
  DEFAULT_DECIMAL,
  DEFAULT_PRICE, GOLD_BASE, GOLD_BASE_POOL,
  isBalancer,
  isCurve,
  isLpUniPair,
  isStableCoin,
  isWeth,
  USDC_BASE,
  USDC_DECIMAL, USDC_P_BASE,
  WETH_BASE,
  XBSX_BASE,
} from '../constant';
import { AedromeFactoryContract } from '../../../generated/StorageListener/AedromeFactoryContract';
import { AedromePoolContract } from '../../../generated/StorageListener/AedromePoolContract';
import { PancakeFactoryContract } from '../../../generated/StorageListener/PancakeFactoryContract';
import { PancakePairContract } from '../../../generated/StorageListener/PancakePairContract';
import { fetchContractDecimal } from '../token-utils';
import { pow, powBI } from '../number-utils';
import { ERC20 } from '../../../generated/StorageListener/ERC20';
import { WeightedPool2TokensContract } from '../../../generated/StorageListener/WeightedPool2TokensContract';
import { BalancerVaultContract } from '../../../generated/StorageListener/BalancerVaultContract';
import { CurveVaultContract } from '../../../generated/StorageListener/CurveVaultContract';
import { CurveMinterContract } from '../../../generated/StorageListener/CurveMinterContract';

export function getPriceForCoinBase(address: Address): BigInt {
  let tokenAddress = address;

  if (isWeth(address)) {
    tokenAddress = WETH_BASE;
  }
  if (address.equals(GOLD_BASE)) {
    return getPriceForBalancerPool(USDC_P_BASE, GOLD_BASE, GOLD_BASE_POOL)
  }
  let price = getPriceForCoinWithSwap(tokenAddress, USDC_BASE, BASE_SWAP_FACTORY_BASE)
  if (price.gt(BigInt.zero())) {
    return price;
  }

  price = getPriceForAerodrome(WETH_BASE, tokenAddress, AERODROME_SWAP_FACTORY_BASE)
  if (price.equals(BigInt.zero())) {
    return price;
  }

  const wethPrice = getPriceForCoinWithSwap(WETH_BASE, USDC_BASE, BASE_SWAP_FACTORY_BASE)

  return price.times(wethPrice).div(BI_18);
}

export function getPriceByVaultBase(vault: Vault): BigDecimal {
  const underlyingAddress = vault.underlying

  if (CB_ETH_ETH_POOL_BASE == vault.id) {
    return getPriceForCoinBase(WETH_BASE).divDecimal(BD_18);
  }

  if (XBSX_BASE == underlyingAddress) {
    return getPriceForCoinBase(BSX_BASE).divDecimal(BD_18);
  }

  const underlying = Token.load(underlyingAddress)
  if (underlying != null) {
    if (isLpUniPair(underlying.name)) {
      return getPriceLpUniPair(underlying.id);
    }

    if (isBalancer(underlying.name)) {
      return getPriceForBalancer(underlying.id);
    }

    if (isCurve(underlying.name)) {
      return getPriceForCurve(underlying.id)
    }
  }
  let price = getPriceForCoinBase(Address.fromString(underlyingAddress))
  if (!price.isZero()) {
    return price.divDecimal(BD_18)
  }

  return BigDecimal.zero()
}

function getPriceLpUniPair(underlyingAddress: string): BigDecimal {
  const uniswapV2Pair = PancakePairContract.bind(Address.fromString(underlyingAddress))
  const tryGetReserves = uniswapV2Pair.try_getReserves()
  if (tryGetReserves.reverted) {
    log.log(log.Level.WARNING, `Can not get reserves for underlyingAddress = ${underlyingAddress}, try get price for coin`)

    return getPriceForCoinBase(Address.fromString(underlyingAddress)).divDecimal(BD_18)
  }
  const reserves = tryGetReserves.value
  const totalSupply = uniswapV2Pair.totalSupply()
  const positionFraction = BD_ONE.div(totalSupply.toBigDecimal().div(BD_18))

  const token0 = uniswapV2Pair.token0()
  const token1 = uniswapV2Pair.token1()

  const firstCoin = reserves.get_reserve0().toBigDecimal().times(positionFraction)
    .div(pow(BD_TEN, fetchContractDecimal(token0).toI32()))
  const secondCoin = reserves.get_reserve1().toBigDecimal().times(positionFraction)
    .div(pow(BD_TEN, fetchContractDecimal(token1).toI32()))


  const token0Price = getPriceForCoinBase(token0)
  const token1Price = getPriceForCoinBase(token1)

  if (token0Price.isZero() || token1Price.isZero()) {
    log.log(log.Level.WARNING, `Some price is zero token0 ${token0.toHex()} = ${token0Price} , token1 ${token1.toHex()} = ${token1Price}`)
    return BigDecimal.zero()
  }

  return token0Price
    .divDecimal(BD_18)
    .times(firstCoin)
    .plus(
      token1Price
        .divDecimal(BD_18)
        .times(secondCoin)
    )
}

function getPriceForBalancer(underlying: string): BigDecimal {
  const balancer = WeightedPool2TokensContract.bind(Address.fromString(underlying))
  const poolId = balancer.getPoolId()
  const totalSupply = balancer.totalSupply()
  const vault = BalancerVaultContract.bind(balancer.getVault())
  const tokenInfo = vault.getPoolTokens(poolId)

  let price = BigDecimal.zero()
  for (let i=0;i<tokenInfo.getTokens().length;i++) {
    const tokenAddress = tokenInfo.getTokens()[i]
    const tryDecimals = ERC20.bind(tokenAddress).try_decimals()
    let decimal = DEFAULT_DECIMAL
    if (!tryDecimals.reverted) {
      decimal = tryDecimals.value
    }
    const balance = normalizePrecision(tokenInfo.getBalances()[i], BigInt.fromI32(decimal)).toBigDecimal()

    let tokenPrice = BD_ZERO;
    if (tokenAddress == Address.fromString(underlying)) {
      tokenPrice = BD_ONE;
    } else if (checkBalancer(tokenAddress)) {
      tokenPrice = getPriceForBalancer(tokenAddress.toHexString());
    } else {
      tokenPrice = getPriceForCoinBase(tokenAddress).divDecimal(BD_18)
    }

    price = price.plus(balance.times(tokenPrice))
  }

  if (price.le(BigDecimal.zero())) {
    return price
  }
  return price.div(totalSupply.toBigDecimal())
}


function getPriceForCurve(underlyingAddress: string): BigDecimal {
  const curveContract = CurveVaultContract.bind(Address.fromString(underlyingAddress))
  const tryMinter = curveContract.try_minter()

  let minter = CurveMinterContract.bind(Address.fromString(underlyingAddress))
  if (!tryMinter.reverted) {
    minter = CurveMinterContract.bind(tryMinter.value)
  }

  let index = 0
  let tryCoins = minter.try_coins(BigInt.fromI32(index))
  while (!tryCoins.reverted) {
    const coin = tryCoins.value
    if (coin.equals(Address.zero())) {
      index = index - 1
      break
    }
    index = index + 1
    tryCoins = minter.try_coins(BigInt.fromI32(index))
  }
  const tryDecimals = curveContract.try_decimals()
  let decimal = DEFAULT_DECIMAL
  if (!tryDecimals.reverted) {
    decimal = tryDecimals.value.toI32()
  } else {
    log.log(log.Level.WARNING, `Can not get decimals for ${underlyingAddress}`)
  }
  const size = index + 1
  if (size < 1) {
    return BigDecimal.zero()
  }

  let value = BigDecimal.zero()

  for (let i=0;i<size;i++) {
    const index = BigInt.fromI32(i)
    const tryCoins1 = minter.try_coins(index)
    if (tryCoins1.reverted) {
      break
    }
    const token = tryCoins1.value
    const tokenPrice = getPriceForCoinBase(token).divDecimal(BD_18)
    const balance = minter.balances(index)
    const tryDecimalsTemp = ERC20.bind(token).try_decimals()
    let decimalsTemp = DEFAULT_DECIMAL
    if (!tryDecimalsTemp.reverted) {
      decimalsTemp = tryDecimalsTemp.value
    } else {
      log.log(log.Level.WARNING, `Can not get decimals for ${token}`)
    }
    const tempBalance = balance.toBigDecimal().div(pow(BD_TEN, decimalsTemp))

    value = value.plus(tokenPrice.times(tempBalance))
  }
  return value.times(BD_18).div(curveContract.totalSupply().toBigDecimal())
}


function normalizePrecision(amount: BigInt, decimal: BigInt): BigInt {
  return amount.div(BI_18.div(BigInt.fromI64(10 ** decimal.toI64())))
}

function getPriceForAerodrome(tokenA: Address, tokenB: Address, factoryAddress: Address): BigInt {
  const factory = AedromeFactoryContract.bind(factoryAddress);
  const tryGetPool = factory.try_getPool1(tokenA, tokenB, false);
  if (tryGetPool.reverted) {
    return BigInt.zero();
  }
  const pool = AedromePoolContract.bind(tryGetPool.value);

  const tryPrices = pool.try_prices(tokenB, BI_18, BigInt.fromString('1'));

  if (tryPrices.reverted) {
    return BigInt.zero();
  }
  return tryPrices.value[0];
}

function getPriceForBalancerPool(tokenA: Address, tokenB: Address, underlying: Address): BigInt {
  const balancer = WeightedPool2TokensContract.bind(underlying)
  const tryGetPoolId = balancer.try_getPoolId()
  if (tryGetPoolId.reverted) {
    return BigInt.zero()
  }
  const vault = BalancerVaultContract.bind(balancer.getVault())
  const tryTokenInfo = vault.try_getPoolTokens(tryGetPoolId.value)
  if (tryTokenInfo.reverted) {
    return BigInt.zero()
  }
  let balanceA = BigInt.zero()
  let balanceB = BigInt.zero()
  for (let i=0;i<tryTokenInfo.value.getTokens().length;i++) {
    const tokenAddress = tryTokenInfo.value.getTokens()[i]
    const tryDecimals = ERC20.bind(tokenAddress).try_decimals()
    let decimal = DEFAULT_DECIMAL
    if (!tryDecimals.reverted) {
      decimal = tryDecimals.value
    }
    if (tokenA.equals(tokenAddress)) {
      balanceA = tryTokenInfo.value.getBalances()[i].div(powBI(BI_TEN, decimal));
    }
    if (tokenB.equals(tokenAddress)) {
      balanceB = tryTokenInfo.value.getBalances()[i].div(powBI(BI_TEN, decimal));
    }

  }

  return balanceA.div(balanceB)
}

function getPriceForCoinWithSwap(address: Address, stableCoin: Address, factory: Address): BigInt {
  if (isStableCoin(address.toHex())) {
    return BI_18
  }
  const uniswapFactoryContract = PancakeFactoryContract.bind(factory)
  const tryGetPair = uniswapFactoryContract.try_getPair(stableCoin, address)
  if (tryGetPair.reverted) {
    return DEFAULT_PRICE
  }

  const poolAddress = tryGetPair.value

  const uniswapPairContract = PancakePairContract.bind(poolAddress);
  const tryGetReserves = uniswapPairContract.try_getReserves()
  if (tryGetReserves.reverted) {
    log.log(log.Level.WARNING, `Can not get reserves for ${poolAddress.toHex()}`)

    return DEFAULT_PRICE
  }
  const reserves = tryGetReserves.value
  const decimal = fetchContractDecimal(address)

  const delimiter = powBI(BI_TEN, decimal.toI32() - USDC_DECIMAL + DEFAULT_DECIMAL)

  return reserves.get_reserve1().times(delimiter).div(reserves.get_reserve0())
}